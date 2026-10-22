import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardForCode, rankCandidates } from './precursor_score.js';
import { addHistoricalIndustryContext } from './historical_replay.js';

const HORIZONS = [1, 3, 5];
const DEFAULT_TOP_KS = [10, 30];

function parseArgs(argv) {
  const out = {
    input: 'output/v13-history-replay/replay_candidates.ndjson',
    qualityReport: 'output/v13-history-replay/replay_report.json',
    output: 'output/v13-history-replay/walk_forward_report.json',
    signalDays: 15
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === '--quality-report' && argv[i + 1]) out.qualityReport = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) out.output = argv[++i];
    else if (argv[i] === '--signal-days' && argv[i + 1]) out.signalDays = Math.max(1, Math.min(60, Number(argv[++i]) || 15));
  }
  return out;
}

export async function readNdjson(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const rows = [];
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { throw new Error('invalid NDJSON at line ' + lineNumber + ': ' + String(error?.message ?? error)); }
  }
  return rows;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}
function pctReturn(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous > 0
    ? (current / previous - 1) * 100
    : null;
}
function limitThresholdPct(code) {
  const board = boardForCode(code);
  if (board === 'CHINEXT' || board === 'STAR') return 19.0;
  if (board === 'BSE') return 28.5;
  return 9.3;
}
function datedBars(stock) {
  return (Array.isArray(stock?.bars) ? stock.bars : [])
    .filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date ?? '')) && Number(bar?.close) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function evaluateCandidateOutcome(stock, signalDate) {
  const bars = datedBars(stock);
  const signalIndex = bars.findLastIndex(bar => bar.date <= signalDate);
  if (signalIndex < 0) return null;
  const signalBar = bars[signalIndex];
  const future = bars.slice(signalIndex + 1, signalIndex + 6);
  const threshold = limitThresholdPct(stock.code);
  const dailyReturns = [];
  let previousClose = Number(signalBar.close);
  for (const bar of future) {
    const currentClose = Number(bar.close);
    dailyReturns.push(pctReturn(currentClose, previousClose));
    previousClose = currentClose;
  }
  const hitWithin = n => dailyReturns.length >= n
    ? dailyReturns.slice(0, n).some(value => Number.isFinite(value) && value >= threshold)
    : null;
  const returnAt = n => future.length >= n
    ? pctReturn(Number(future[n - 1].close), Number(signalBar.close))
    : null;
  const hasFiveBars = future.length >= 5;
  const highs = future.slice(0, 5).map(bar => Number(bar.high ?? bar.close)).filter(Number.isFinite);
  const lows = future.slice(0, 5).map(bar => Number(bar.low ?? bar.close)).filter(Number.isFinite);
  return {
    code: String(stock.code ?? ''),
    signalDate,
    signalClose: Number(signalBar.close),
    futureBarsAvailable: future.length,
    t1CloseReturnPct: returnAt(1),
    t3CloseReturnPct: returnAt(3),
    t5CloseReturnPct: returnAt(5),
    limitUpWithin1: hitWithin(1),
    limitUpWithin3: hitWithin(3),
    limitUpWithin5: hitWithin(5),
    maxHighReturn5Pct: hasFiveBars && highs.length ? pctReturn(Math.max(...highs), Number(signalBar.close)) : null,
    maxAdverseExcursion5Pct: hasFiveBars && lows.length ? pctReturn(Math.min(...lows), Number(signalBar.close)) : null
  };
}

function metricsForTopK(rankedCodes, k, universeCodes, outcomeByCode) {
  const topCodes = rankedCodes.slice(0, k);
  const metrics = {};
  for (const horizon of HORIZONS) {
    const returnKey = 't' + horizon + 'CloseReturnPct';
    const hitKey = 'limitUpWithin' + horizon;
    const topRows = topCodes.map(code => outcomeByCode.get(code))
      .filter(row => row && Number.isFinite(row[returnKey]));
    const universeRows = universeCodes.map(code => outcomeByCode.get(code))
      .filter(row => row && Number.isFinite(row[returnKey]));
    const hitCount = topRows.filter(row => row[hitKey] === true).length;
    const universeHitCount = universeRows.filter(row => row[hitKey] === true).length;
    const closeReturns = topRows.map(row => row[returnKey]);
    const riskRows = topCodes.map(code => outcomeByCode.get(code))
      .filter(row => row && Number.isFinite(row.maxHighReturn5Pct) && Number.isFinite(row.maxAdverseExcursion5Pct));
    metrics['t' + horizon] = {
      evaluatedTopCount: topRows.length,
      universeOutcomeCount: universeRows.length,
      universeLimitUpCount: universeHitCount,
      limitUpHitCount: hitCount,
      limitUpPrecisionPct: topRows.length ? Number((hitCount / topRows.length * 100).toFixed(2)) : null,
      limitUpRecallPct: universeHitCount ? Number((hitCount / universeHitCount * 100).toFixed(2)) : null,
      meanCloseReturnPct: mean(closeReturns) === null ? null : Number(mean(closeReturns).toFixed(2)),
      winRatePct: topRows.length ? Number((topRows.filter(row => row[returnKey] > 0).length / topRows.length * 100).toFixed(2)) : null,
      meanMaxHighReturn5Pct: riskRows.length ? Number(mean(riskRows.map(row => row.maxHighReturn5Pct)).toFixed(2)) : null,
      meanMaxAdverseExcursion5Pct: riskRows.length ? Number(mean(riskRows.map(row => row.maxAdverseExcursion5Pct)).toFixed(2)) : null
    };
  }
  return metrics;
}

function aggregateMetrics(perDate, rankingKey, topK) {
  const output = {};
  for (const horizon of HORIZONS) {
    const rows = perDate.map(day => day[rankingKey]['top' + topK]['t' + horizon]);
    const avg = key => mean(rows.map(row => row[key]));
    output['t' + horizon] = {
      signalDates: rows.filter(row => Number.isFinite(row.meanCloseReturnPct)).length,
      meanLimitUpPrecisionPct: avg('limitUpPrecisionPct'),
      meanLimitUpRecallPct: avg('limitUpRecallPct'),
      meanCloseReturnPct: avg('meanCloseReturnPct'),
      meanWinRatePct: avg('winRatePct'),
      meanMaxHighReturn5Pct: avg('meanMaxHighReturn5Pct'),
      meanMaxAdverseExcursion5Pct: avg('meanMaxAdverseExcursion5Pct')
    };
    for (const key of Object.keys(output['t' + horizon])) {
      if (key !== 'signalDates' && Number.isFinite(output['t' + horizon][key])) {
        output['t' + horizon][key] = Number(output['t' + horizon][key].toFixed(2));
      } else if (key !== 'signalDates') {
        output['t' + horizon][key] = null;
      }
    }
  }
  return output;
}

export function auditTargetRanks(candidates, targets, signalDate) {
  const validHistories = (Array.isArray(candidates) ? candidates : [])
    .map(stock => ({ ...stock, bars: datedBars(stock) }))
    .filter(stock => stock.bars.length >= 25);
  const preCutoff = validHistories.map(stock => ({
    ...stock,
    asOf: signalDate,
    bars: stock.bars.filter(bar => bar.date <= signalDate),
    flows: (Array.isArray(stock.flows) ? stock.flows : [])
      .filter(flow => /^\d{4}-\d{2}-\d{2}$/.test(String(flow?.date ?? '')) && flow.date <= signalDate)
  })).filter(stock => stock.bars.length >= 25);
  const withContext = addHistoricalIndustryContext(preCutoff);
  const pointInTime = withContext.map(stock => {
    const latest = stock.bars.at(-1);
    return {
      ...stock, asOf: signalDate,
      isST: Boolean(stock.isST) || /ST|退/i.test(String(stock.name ?? '')),
      amount: latest?.amount, turnoverRate: latest?.turnoverRate
    };
  });
  const variants = [
    ['currentComposite', 'v13-current'],
    ['coreOnly', 'v13-core-only'],
    ['earlyTurn', 'v13-early-turn']
  ];
  const rankedByVariant = new Map();
  for (const [key, modelVariant] of variants) {
    rankedByVariant.set(key, rankCandidates(pointInTime, { asOf: signalDate, modelVariant }));
  }
  const currentRanked = rankedByVariant.get('currentComposite') ?? [];
  const emotionRepairRanked = [...currentRanked]
    .filter(row => Number(row.components?.emotionRepair) >= 65)
    .sort((a, b) => Number(b.components?.emotionRepair) - Number(a.components?.emotionRepair) || b.confidence - a.confidence);
  const oversoldRanked = [...currentRanked]
    .filter(row => Number(row.components?.oversoldReversal) >= 65)
    .sort((a, b) => Number(b.components?.oversoldReversal) - Number(a.components?.oversoldReversal) || b.confidence - a.confidence);
  const rankedLists = {
    currentComposite: currentRanked,
    coreOnly: rankedByVariant.get('coreOnly') ?? [],
    earlyTurn: rankedByVariant.get('earlyTurn') ?? [],
    emotionRepairWatch: emotionRepairRanked,
    oversoldWatch: oversoldRanked
  };
  const ranks = {};
  for (const [variant, ranked] of Object.entries(rankedLists)) {
    const rankMap = new Map(ranked.map((row, index) => [String(row.code), { row, rank: index + 1 }]));
    ranks[variant] = (Array.isArray(targets) ? targets : [])
      .filter(target => !target.signalDate || target.signalDate === signalDate)
      .map(target => {
        const hit = rankMap.get(String(target.code));
        return {
          code: String(target.code), name: String(target.name ?? target.code),
          knownOutcome: target.outcome ?? null,
          rank: hit?.rank ?? null,
          inTop10: Boolean(hit && hit.rank <= 10),
          inTop30: Boolean(hit && hit.rank <= 30),
          inTop50: Boolean(hit && hit.rank <= 50),
          score: hit?.row.score ?? null,
          scorePath: hit?.row.scorePath ?? null,
          setup: hit?.row.setup ?? null,
          components: hit?.row.components ?? null,
          features: hit?.row.features ?? null,
          riskFlags: hit?.row.riskFlags ?? [],
          scored: Boolean(hit),
          missingReason: hit ? null : 'not_scored_or_excluded'
        };
      });
  }
  return {
    signalDate,
    status: Object.values(ranks).every(rows => rows.every(row => row.scored)) ? 'MEASURABLE' : 'NOT_MEASURABLE',
    universeCount: pointInTime.length,
    variants: ranks,
    policy: 'Target outcomes are attached only after point-in-time ranks are computed; target labels never enter feature construction or score calculation.'
  };
}

export function evaluateWalkForward(candidates, {
  signalDays = 15,
  sourceCoveragePct = null,
  sourceQualityReasons = []
} = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const validHistories = rows.map(stock => ({ ...stock, bars: datedBars(stock) }))
    .filter(stock => stock.bars.length >= 25);
  const sessionDates = [...new Set(validHistories.flatMap(stock => stock.bars.map(bar => bar.date)))]
    .sort((a, b) => a.localeCompare(b));
  const eligibleDates = sessionDates.slice(0, Math.max(0, sessionDates.length - 5)).slice(-signalDays);
  const perDate = [];
  for (const signalDate of eligibleDates) {
    const preCutoff = validHistories.map(stock => ({
      ...stock,
      asOf: signalDate,
      bars: stock.bars.filter(bar => bar.date <= signalDate),
      flows: (Array.isArray(stock.flows) ? stock.flows : []).filter(flow => /^\d{4}-\d{2}-\d{2}$/.test(String(flow?.date ?? '')) && flow.date <= signalDate)
    })).filter(stock => stock.bars.length >= 25);
    const withContext = addHistoricalIndustryContext(preCutoff);
    const candidatesAtDate = withContext.map(stock => {
      const latest = stock.bars.at(-1);
      return {
        ...stock,
        asOf: signalDate,
        isST: Boolean(stock.isST) || /ST|退/i.test(String(stock.name ?? '')),
        amount: latest?.amount,
        turnoverRate: latest?.turnoverRate
      };
    });
    const ranked = rankCandidates(candidatesAtDate, { asOf: signalDate, modelVariant: 'v13-current' });
    const coreRanked = rankCandidates(candidatesAtDate, { asOf: signalDate, modelVariant: 'v13-core-only' });
    const earlyTurnRanked = rankCandidates(candidatesAtDate, { asOf: signalDate, modelVariant: 'v13-early-turn' });
    const modelCodes = ranked.map(row => row.code);
    const coreOnlyCodes = coreRanked.map(row => row.code);
    const earlyTurnCodes = earlyTurnRanked.map(row => row.code);
    const momentumRanked = [...ranked].sort((a, b) => {
      const ar = Number.isFinite(a.features?.r5Pct) ? a.features.r5Pct : -Infinity;
      const br = Number.isFinite(b.features?.r5Pct) ? b.features.r5Pct : -Infinity;
      return br - ar || b.confidence - a.confidence;
    });
    const momentumCodes = momentumRanked.map(row => row.code);
    const emotionRepairCodes = [...ranked]
      .filter(row => Number(row.components?.emotionRepair) >= 65)
      .sort((a, b) => Number(b.components?.emotionRepair) - Number(a.components?.emotionRepair) || b.confidence - a.confidence)
      .map(row => row.code);
    const oversoldCodes = [...ranked]
      .filter(row => Number(row.components?.oversoldReversal) >= 65)
      .sort((a, b) => Number(b.components?.oversoldReversal) - Number(a.components?.oversoldReversal) || b.confidence - a.confidence)
      .map(row => row.code);
    const rawByCode = new Map(validHistories.map(stock => [String(stock.code), stock]));
    const outcomeByCode = new Map();
    for (const code of modelCodes) {
      const raw = rawByCode.get(String(code));
      if (raw) {
        const outcome = evaluateCandidateOutcome(raw, signalDate);
        if (outcome) outcomeByCode.set(String(code), outcome);
      }
    }
    const universeCodes = modelCodes.filter(code => outcomeByCode.has(String(code)));
    const t5OutcomeCount = modelCodes.filter(code => Number.isFinite(outcomeByCode.get(String(code))?.t5CloseReturnPct)).length;
    const t5OutcomeCoveragePct = modelCodes.length ? Number((t5OutcomeCount / modelCodes.length * 100).toFixed(2)) : 0;
    const day = {
      signalDate,
      scoredUniverseCount: modelCodes.length,
      outcomeCoverageCount: t5OutcomeCount,
      t5OutcomeCoveragePct,
      modelTop10Codes: modelCodes.slice(0, 10),
      coreOnlyTop10Codes: coreOnlyCodes.slice(0, 10),
      earlyTurnTop10Codes: earlyTurnCodes.slice(0, 10),
      emotionRepairTop10Codes: emotionRepairCodes.slice(0, 10),
      oversoldTop10Codes: oversoldCodes.slice(0, 10),
      momentumTop10Codes: momentumCodes.slice(0, 10),
      modelTop30Codes: modelCodes.slice(0, 30),
      coreOnlyTop30Codes: coreOnlyCodes.slice(0, 30),
      earlyTurnTop30Codes: earlyTurnCodes.slice(0, 30),
      momentumTop30Codes: momentumCodes.slice(0, 30),
      model: {},
      coreOnly: {},
      earlyTurn: {},
      emotionRepairWatch: {},
      oversoldWatch: {},
      momentum: {}
    };
    for (const k of DEFAULT_TOP_KS) {
      day.model['top' + k] = metricsForTopK(modelCodes, k, universeCodes, outcomeByCode);
      day.coreOnly['top' + k] = metricsForTopK(coreOnlyCodes, k, universeCodes, outcomeByCode);
      day.earlyTurn['top' + k] = metricsForTopK(earlyTurnCodes, k, universeCodes, outcomeByCode);
      day.emotionRepairWatch['top' + k] = metricsForTopK(emotionRepairCodes, k, universeCodes, outcomeByCode);
      day.oversoldWatch['top' + k] = metricsForTopK(oversoldCodes, k, universeCodes, outcomeByCode);
      day.momentum['top' + k] = metricsForTopK(momentumCodes, k, universeCodes, outcomeByCode);
    }
    perDate.push(day);
  }

  const coveragePct = Number.isFinite(Number(sourceCoveragePct)) ? Number(sourceCoveragePct) : null;
  const reasons = [...sourceQualityReasons];
  if (coveragePct === null) reasons.push('source-coverage-report-missing');
  else if (coveragePct < 90) reasons.push('historical-bar-coverage-below-90pct');
  if (eligibleDates.length < 3) reasons.push('fewer-than-three-complete-forward-evaluation-dates');
  const outcomeCoverageValues = perDate.map(day => day.t5OutcomeCoveragePct).filter(Number.isFinite);
  const minimumT5OutcomeCoveragePct = outcomeCoverageValues.length ? Math.min(...outcomeCoverageValues) : 0;
  if (minimumT5OutcomeCoveragePct < 80) reasons.push('forward-outcome-coverage-below-80pct');
  const measurable = reasons.length === 0;
  const summary = {};
  for (const k of DEFAULT_TOP_KS) {
    summary['top' + k] = {
      model: aggregateMetrics(perDate, 'model', k),
      coreOnly: aggregateMetrics(perDate, 'coreOnly', k),
      earlyTurn: aggregateMetrics(perDate, 'earlyTurn', k),
      emotionRepairWatch: aggregateMetrics(perDate, 'emotionRepairWatch', k),
      oversoldWatch: aggregateMetrics(perDate, 'oversoldWatch', k),
      momentumBaseline: aggregateMetrics(perDate, 'momentum', k)
    };
  }
  return {
    model: 'V13-limitup-precursor-walk-forward',
    status: measurable ? 'MEASURABLE' : 'NOT_MEASURABLE',
    measurable,
    reasons: [...new Set(reasons)],
    dataPolicy: {
      features: 'For each signalDate, K-line and fund-flow rows are sliced to dates <= signalDate before scoring; sector context is rebuilt from those pre-signal bars only',
      outcomes: 'Only rows strictly after signalDate are used to calculate T+1/T+3/T+5 close returns, limit-up hits, maximum favorable excursion, and maximum adverse excursion',
      baseline: 'Five-trading-session momentum ranking on the same scored candidate universe',
      variants: 'Compare the legacy blended score, core-only alpha score, and experimental early-turn score; emotion-repair and oversold scores are separately evaluated as observation lanes',
      noTargetTuning: 'The screenshot target labels are not loaded or used by this evaluator'
    },
    sourceCoveragePct: coveragePct,
    minimumT5OutcomeCoveragePct,
    candidateCount: rows.length,
    historiesWithAtLeast25Bars: validHistories.length,
    availableSessionCount: sessionDates.length,
    signalDateCount: eligibleDates.length,
    signalDates: eligibleDates,
    summary,
    perDate
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const inputPath = resolve(args.input);
  const qualityPath = resolve(args.qualityReport);
  const outputPath = resolve(args.output);
  const candidates = await readNdjson(inputPath);
  let sourceCoveragePct = null;
  const sourceQualityReasons = [];
  try {
    const qualityReport = JSON.parse(await readFile(qualityPath, 'utf8'));
    const value = Number(qualityReport?.coverage?.barCoveragePct);
    if (Number.isFinite(value)) sourceCoveragePct = value;
    else sourceQualityReasons.push('source-bar-coverage-missing');
  } catch {
    sourceQualityReasons.push('source-quality-report-unavailable');
  }
  const report = evaluateWalkForward(candidates, {
    signalDays: args.signalDays, sourceCoveragePct, sourceQualityReasons
  });
  const targetConfig = JSON.parse(await readFile(resolve('research/v13-limitup-precursor/target_symbols.json'), 'utf8'));
  const targetDates = [...new Set((Array.isArray(targetConfig?.targets) ? targetConfig.targets : [])
    .map(target => target.signalDate).filter(Boolean))];
  report.targetAudit = targetDates.map(signalDate => auditTargetRanks(candidates, targetConfig.targets, signalDate));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    model: report.model, status: report.status, reasons: report.reasons,
    sourceCoveragePct: report.sourceCoveragePct, candidateCount: report.candidateCount,
    signalDateCount: report.signalDateCount, signalDates: report.signalDates,
    summary: report.summary
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
