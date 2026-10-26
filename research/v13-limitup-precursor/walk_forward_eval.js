import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardForCode, scoreCandidate, rankScoredCandidates } from './precursor_score.js';
import { addHistoricalIndustryContext } from './historical_replay.js';
import { rankCoreSelection } from './core_selection.js';
import { rankPreBreakoutCandidates } from './pre_breakout.js';
import { deriveMarketRegime, scorePolicyAlignment, POLICY_CATALOG_VERSION, POLICY_CATALOG_REVIEWED_AT } from './policy_alignment.js';
import { computeEarlyOpportunity } from '../v11-short-alpha/early_opportunity.js';

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
function isHistoricalCorePreLimitUpCandidate(row = {}, early = null) {
  const board = boardForCode(row.code);
  const dailyPct = Number(row.quote?.pct ?? row.currentPct);
  const r5 = Number(row.features?.r5Pct);
  const distHigh20 = Number(row.features?.distHigh20Pct);
  const limitPct = board === 'CHINEXT' || board === 'STAR' ? 20 : board === 'BSE' ? 30 : 10;
  if (Number.isFinite(dailyPct) && dailyPct >= limitPct * 0.75) return false;
  if (early?.stage === 'extended') return false;
  if (Number.isFinite(r5) && r5 > 25) return false;
  if (Number.isFinite(distHigh20) && distHigh20 > 18) return false;
  return true;
}
function dailyChangePct(stock) {
  const bars = Array.isArray(stock?.bars) ? stock.bars : [];
  const latest = bars.at(-1), previous = bars.at(-2);
  return Number(previous?.close) > 0 && Number(latest?.close) > 0
    ? (Number(latest.close) / Number(previous.close) - 1) * 100 : null;
}
function evidenceDateAtOrBefore(value, cutoff) {
  const date = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= cutoff;
}
const DATED_BARS_CACHE = new WeakMap();
function datedBars(stock) {
  const source = Array.isArray(stock?.bars) ? stock.bars : [];
  const cached = stock && typeof stock === 'object' ? DATED_BARS_CACHE.get(stock) : null;
  if (cached && cached.source === source) return cached.rows;
  const rows = source
    .filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date ?? '')) && Number(bar?.close) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (stock && typeof stock === 'object') DATED_BARS_CACHE.set(stock, { source, rows });
  return rows;
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

function interleaveCodes(primary, secondary, limit) {
  const out = [];
  const seen = new Set();
  let p = 0, s = 0, takePrimary = true;
  while (out.length < limit && (p < primary.length || s < secondary.length)) {
    const list = takePrimary ? primary : secondary;
    let index = takePrimary ? p : s;
    if (index >= list.length) {
      takePrimary = !takePrimary;
      continue;
    }
    const code = String(list[index]);
    if (takePrimary) p++; else s++;
    takePrimary = !takePrimary;
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
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
    const marketUniverseRows = withContext.map(stock => {
      const latest = stock.bars.at(-1);
      const latestFlow = (Array.isArray(stock.flows) ? stock.flows : []).at(-1);
      return {
        code: stock.code, name: stock.name, pct: dailyChangePct(stock),
        mainNet: latestFlow?.mainNet !== null && latestFlow?.mainNet !== undefined
          && latestFlow?.mainNet !== '' && Number.isFinite(Number(latestFlow.mainNet))
          ? Number(latestFlow.mainNet) : null,
        amount: latest?.amount
      };
    }).filter(row => Number.isFinite(row.pct));
    const marketRegime = deriveMarketRegime({
      universeRows: marketUniverseRows,
      capturedAt: signalDate + 'T15:00:00+08:00'
    });
    const candidatesAtDate = withContext.map(stock => {
      const latest = stock.bars.at(-1);
      const dailyPct = dailyChangePct(stock);
      // Only explicitly point-in-time sector/theme metadata is allowed to establish policy evidence.
      // The replay's current industry label is still used for sector-return diagnostics, but not
      // silently treated as historical policy exposure or proof of theme leadership.
      const metadataAsOf = stock.pointInTimeMetadataAsOf ?? stock.metadataAsOf ?? null;
      const metadataIsPointInTime = evidenceDateAtOrBefore(metadataAsOf, signalDate);
      const leaderEvidenceAsOf = stock.pointInTimeLeaderEvidence?.asOf
        ?? stock.pointInTimeLeaderEvidence?.observedAt
        ?? metadataAsOf;
      const leaderEvidence = stock.pointInTimeLeaderEvidence
        && evidenceDateAtOrBefore(leaderEvidenceAsOf, signalDate)
        ? stock.pointInTimeLeaderEvidence : null;
      const policyAlignment = scorePolicyAlignment({
        industry: metadataIsPointInTime ? stock.pointInTimeIndustry ?? '' : '',
        themeNames: metadataIsPointInTime ? stock.pointInTimeThemeNames ?? [] : [],
        companyNews: stock.companyNews ?? [],
        asOf: signalDate
      });
      return {
        ...stock,
        asOf: signalDate,
        isST: Boolean(stock.isST) || /ST|退/i.test(String(stock.name ?? '')),
        amount: latest?.amount,
        turnoverRate: latest?.turnoverRate,
        currentPct: dailyPct,
        quote: { ...(stock.quote ?? {}), pct: dailyPct, amount: latest?.amount, turnoverRate: latest?.turnoverRate },
        policyAlignment,
        marketRegime,
        leaderEvidence,
        source: {
          ...(stock.source ?? {}),
          barCount: stock.bars.length,
          historicalFlowCount: (Array.isArray(stock.flows) ? stock.flows : []).length
        }
      };
    });
    const baseScored = candidatesAtDate
      .map(stock => scoreCandidate(stock, { asOf: signalDate, modelVariant: 'v13-current', marketRegime }))
      .filter(Boolean);
    const ranked = rankScoredCandidates(baseScored, 'v13-current');
    const coreRanked = rankScoredCandidates(baseScored, 'v13-core-only');
    const earlyTurnRanked = rankScoredCandidates(baseScored, 'v13-early-turn');
    const momentumHybridRanked = rankScoredCandidates(baseScored, 'v13-momentum-hybrid');
    const rankEnsembleRanked = rankScoredCandidates(baseScored, 'v13-rank-ensemble');
    const currentByCode = new Map(ranked.map(row => [String(row.code), row]));
    const v12EarlyOpportunityRanked = candidatesAtDate.map(stock => {
      const base = currentByCode.get(String(stock.code));
      if (!base) return null;
      const opportunity = computeEarlyOpportunity({
        bars: stock.bars,
        asOf: signalDate,
        features: {
          sector: { score: base.components?.sector },
          capital: { score: base.components?.flow }
        }
      });
      if (!Number.isFinite(Number(opportunity.score))) return null;
      return {
        ...base,
        score: Number(opportunity.score),
        scorePath: 'v12-early-opportunity',
        setup: opportunity.stage,
        components: { ...base.components, v12EarlyOpportunity: Number(opportunity.score) },
        features: { ...base.features, earlyOpportunity: opportunity },
        confidence: Number((opportunity.confidence * 100).toFixed(1))
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.confidence - a.confidence);

    // Evaluate the same strict four-layer selector used by the V13 live observation panel.
    // Missing point-in-time policy/theme/leader evidence is left missing; no industry-only
    // proxy is allowed to masquerade as a verified theme leader.
    // Reuse the shared feature pass; switch only the score path to the policy-aware composite
    // so the strict selector matches the live model without scoring every history twice.
    const coreBaseScored = baseScored.map(row => {
      const policyAwareGross = Number(row.components?.policyAwareComposite ?? row.grossScore);
      const riskPenalty = Number(row.riskPenalty ?? 0);
      const score = Math.max(0, Math.min(100, policyAwareGross - riskPenalty));
      const policyAdjusted = row.policyAlignment?.evidenceAvailable === true
        && policyAwareGross > Number(row.components?.coreComposite ?? policyAwareGross) + 0.5;
      return {
        ...row,
        modelVariant: 'v13-policy-aware',
        grossScore: Number(policyAwareGross.toFixed(1)),
        score: Number(score.toFixed(1)),
        scorePath: policyAdjusted ? 'policy-market-aligned' : 'market-regime-adjusted'
      };
    });
    const earlyByCode = new Map(v12EarlyOpportunityRanked.map(row => [String(row.code), {
      stage: row.setup,
      metrics: row.features?.earlyOpportunity?.metrics ?? {},
      components: row.features?.earlyOpportunity?.components ?? {}
    }]));
    const coreEligibleCodes = new Set(coreBaseScored
      .filter(row => isHistoricalCorePreLimitUpCandidate(row, earlyByCode.get(String(row.code))))
      .map(row => String(row.code)));
    const coreSelectionResult = rankCoreSelection(coreBaseScored, {
      marketRegime, eligibleCodes: coreEligibleCodes, maxResults: 5
    });
    const coreSelectionCodes = coreSelectionResult.ranking.map(row => String(row.code));
    const preBreakoutResult = rankPreBreakoutCandidates(coreBaseScored, earlyByCode, { maxResults: 15, minScore: 60 });
    const preBreakoutCodes = preBreakoutResult.ranking.map(row => String(row.code));
    const preBreakoutDiagnostics = {
      assessedCount: preBreakoutResult.summary.assessedCount,
      passedGateCount: preBreakoutResult.summary.passedGateCount,
      returnedCount: preBreakoutResult.summary.returnedCount,
      verifiedLeaderCount: preBreakoutResult.summary.verifiedLeaderCount,
      policyVerifiedCount: preBreakoutResult.summary.policyVerifiedCount,
      unverifiedLeaderCount: preBreakoutResult.summary.unverifiedLeaderCount
    };
    const corePolicyEvidenceCount = candidatesAtDate.filter(stock =>
      stock.policyAlignment?.evidenceAvailable === true && stock.policyAlignment?.catalogStale !== true).length;
    const coreLeaderEvidenceCount = candidatesAtDate.filter(stock => Boolean(stock.leaderEvidence)).length;
    const corePolicyCatalogAvailable = candidatesAtDate.some(stock => stock.policyAlignment?.catalogAvailableAtCutoff === true);
    const corePolicyCatalogStale = candidatesAtDate.some(stock => stock.policyAlignment?.catalogStale === true);
    const coreSelectionDiagnostics = {
      selectorVersion: coreSelectionResult.summary.version,
      marketRegime: marketRegime.regime,
      marketRegimeLabel: marketRegime.label,
      marketDataQuality: marketRegime.dataQuality,
      policyCatalogVersion: POLICY_CATALOG_VERSION,
      policyCatalogReviewedAt: POLICY_CATALOG_REVIEWED_AT,
      policyCatalogAvailableAtCutoff: corePolicyCatalogAvailable,
      policyCatalogStaleAtCutoff: corePolicyCatalogStale,
      pointInTimePolicyEvidenceCount: corePolicyEvidenceCount,
      pointInTimeLeaderEvidenceCount: coreLeaderEvidenceCount,
      assessedCount: coreSelectionResult.summary.assessedCount,
      preLimitUpEligibleCount: coreEligibleCodes.size,
      strictEligibleCount: coreSelectionResult.summary.eligibleCount,
      selectedCount: coreSelectionCodes.length,
      rejectionCounts: coreSelectionResult.summary.rejectionCounts
    };
    const modelCodes = ranked.map(row => row.code);
    const coreOnlyCodes = coreRanked.map(row => row.code);
    const earlyTurnCodes = earlyTurnRanked.map(row => row.code);
    const momentumHybridCodes = momentumHybridRanked.map(row => row.code);
    const rankEnsembleCodes = rankEnsembleRanked.map(row => row.code);
    const v12EarlyOpportunityCodes = v12EarlyOpportunityRanked.map(row => row.code);
    const momentumRanked = [...ranked].sort((a, b) => {
      const ar = Number.isFinite(a.features?.r5Pct) ? a.features.r5Pct : -Infinity;
      const br = Number.isFinite(b.features?.r5Pct) ? b.features.r5Pct : -Infinity;
      return br - ar || b.confidence - a.confidence;
    });
    const momentumCodes = momentumRanked.map(row => row.code);
    const balancedBlendTop10Codes = interleaveCodes(momentumCodes, v12EarlyOpportunityCodes, 10);
    const balancedBlendTop30Codes = interleaveCodes(momentumCodes, v12EarlyOpportunityCodes, 30);
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
    for (const code of new Set([...modelCodes, ...coreSelectionCodes, ...preBreakoutCodes])) {
      const raw = rawByCode.get(String(code));
      if (raw) {
        const outcome = evaluateCandidateOutcome(raw, signalDate);
        if (outcome) outcomeByCode.set(String(code), outcome);
      }
    }
    const universeCodes = [...new Set([...modelCodes, ...coreSelectionCodes, ...preBreakoutCodes])]
      .filter(code => outcomeByCode.has(String(code)));
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
      momentumHybridTop10Codes: momentumHybridCodes.slice(0, 10),
      rankEnsembleTop10Codes: rankEnsembleCodes.slice(0, 10),
      v12EarlyOpportunityTop10Codes: v12EarlyOpportunityCodes.slice(0, 10),
      emotionRepairTop10Codes: emotionRepairCodes.slice(0, 10),
      oversoldTop10Codes: oversoldCodes.slice(0, 10),
      momentumTop10Codes: momentumCodes.slice(0, 10),
      modelTop30Codes: modelCodes.slice(0, 30),
      coreOnlyTop30Codes: coreOnlyCodes.slice(0, 30),
      earlyTurnTop30Codes: earlyTurnCodes.slice(0, 30),
      momentumHybridTop30Codes: momentumHybridCodes.slice(0, 30),
      rankEnsembleTop30Codes: rankEnsembleCodes.slice(0, 30),
      v12EarlyOpportunityTop30Codes: v12EarlyOpportunityCodes.slice(0, 30),
      momentumTop30Codes: momentumCodes.slice(0, 30),
      balancedBlendTop10Codes,
      balancedBlendTop30Codes,
      coreSelectionTop5Codes: coreSelectionCodes,
      coreSelectionDiagnostics,
      preBreakoutTop15Codes: preBreakoutCodes,
      preBreakoutDiagnostics,
      model: {},
      preBreakout: {},
      coreSelection: {},
      coreOnly: {},
      earlyTurn: {},
      momentumHybrid: {},
      rankEnsemble: {},
      v12EarlyOpportunity: {},
      balancedBlend: {},
      emotionRepairWatch: {},
      oversoldWatch: {},
      momentum: {}
    };
    day.coreSelection.top5 = metricsForTopK(coreSelectionCodes, 5, universeCodes, outcomeByCode);
    day.preBreakout.top10 = metricsForTopK(preBreakoutCodes, 10, universeCodes, outcomeByCode);
    day.preBreakout.top15 = metricsForTopK(preBreakoutCodes, 15, universeCodes, outcomeByCode);
    for (const k of DEFAULT_TOP_KS) {
      day.model['top' + k] = metricsForTopK(modelCodes, k, universeCodes, outcomeByCode);
      day.coreOnly['top' + k] = metricsForTopK(coreOnlyCodes, k, universeCodes, outcomeByCode);
      day.earlyTurn['top' + k] = metricsForTopK(earlyTurnCodes, k, universeCodes, outcomeByCode);
      day.momentumHybrid['top' + k] = metricsForTopK(momentumHybridCodes, k, universeCodes, outcomeByCode);
      day.rankEnsemble['top' + k] = metricsForTopK(rankEnsembleCodes, k, universeCodes, outcomeByCode);
      day.v12EarlyOpportunity['top' + k] = metricsForTopK(v12EarlyOpportunityCodes, k, universeCodes, outcomeByCode);
      day.emotionRepairWatch['top' + k] = metricsForTopK(emotionRepairCodes, k, universeCodes, outcomeByCode);
      day.oversoldWatch['top' + k] = metricsForTopK(oversoldCodes, k, universeCodes, outcomeByCode);
      day.momentum['top' + k] = metricsForTopK(momentumCodes, k, universeCodes, outcomeByCode);
      const blendCodes = k === 10 ? balancedBlendTop10Codes : balancedBlendTop30Codes;
      day.balancedBlend['top' + k] = metricsForTopK(blendCodes, k, universeCodes, outcomeByCode);
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
      momentumHybrid: aggregateMetrics(perDate, 'momentumHybrid', k),
      rankEnsemble: aggregateMetrics(perDate, 'rankEnsemble', k),
      v12EarlyOpportunity: aggregateMetrics(perDate, 'v12EarlyOpportunity', k),
      emotionRepairWatch: aggregateMetrics(perDate, 'emotionRepairWatch', k),
      oversoldWatch: aggregateMetrics(perDate, 'oversoldWatch', k),
      momentumBaseline: aggregateMetrics(perDate, 'momentum', k),
      balancedBlend: aggregateMetrics(perDate, 'balancedBlend', k)
    };
  }
  const coreSelectionTop5 = aggregateMetrics(perDate, 'coreSelection', 5);
  const preBreakoutTop10 = aggregateMetrics(perDate, 'preBreakout', 10);
  const preBreakoutTop15 = aggregateMetrics(perDate, 'preBreakout', 15);
  const preBreakoutReturnedRows = perDate.reduce((sum, day) => sum + day.preBreakoutDiagnostics.returnedCount, 0);
  const preBreakoutLeaderRows = perDate.reduce((sum, day) => sum + day.preBreakoutDiagnostics.verifiedLeaderCount, 0);
  const preBreakoutPolicyRows = perDate.reduce((sum, day) => sum + day.preBreakoutDiagnostics.policyVerifiedCount, 0);
  const corePolicyEvidenceRows = perDate.reduce((sum, day) => sum + day.coreSelectionDiagnostics.pointInTimePolicyEvidenceCount, 0);
  const coreLeaderEvidenceRows = perDate.reduce((sum, day) => sum + day.coreSelectionDiagnostics.pointInTimeLeaderEvidenceCount, 0);
  const coreStrictEligibleCount = perDate.reduce((sum, day) => sum + day.coreSelectionDiagnostics.strictEligibleCount, 0);
  const coreSelectedCount = perDate.reduce((sum, day) => sum + day.coreSelectionDiagnostics.selectedCount, 0);
  const coreSelectionReasons = [];
  if (coveragePct === null) coreSelectionReasons.push('source-coverage-report-missing');
  else if (coveragePct < 90) coreSelectionReasons.push('historical-bar-coverage-below-90pct');
  if (eligibleDates.length < 3) coreSelectionReasons.push('fewer-than-three-complete-forward-evaluation-dates');
  if (minimumT5OutcomeCoveragePct < 80) coreSelectionReasons.push('forward-outcome-coverage-below-80pct');
  if (corePolicyEvidenceRows === 0) coreSelectionReasons.push('point-in-time-policy-evidence-unavailable');
  if (coreLeaderEvidenceRows === 0) coreSelectionReasons.push('point-in-time-theme-leader-evidence-unavailable');
  if (coreStrictEligibleCount === 0) coreSelectionReasons.push('strict-core-selector-has-no-qualified-candidates');
  const coreSelectionMeasurable = coreSelectionReasons.length === 0;
  const coreSelectionEvaluation = {
    status: coreSelectionMeasurable ? 'MEASURABLE' : 'NOT_MEASURABLE',
    measurable: coreSelectionMeasurable,
    reasons: [...new Set(coreSelectionReasons)],
    selectorVersion: 'four-layer-strict-core-leader-selection-v1',
    policyCatalogVersion: POLICY_CATALOG_VERSION,
    policyCatalogReviewedAt: POLICY_CATALOG_REVIEWED_AT,
    signalDateCount: eligibleDates.length,
    pointInTimePolicyEvidenceRows: corePolicyEvidenceRows,
    pointInTimeLeaderEvidenceRows: coreLeaderEvidenceRows,
    strictEligibleCandidateCount: coreStrictEligibleCount,
    selectedCandidateCount: coreSelectedCount,
    top5: coreSelectionTop5,
    interpretation: 'A strict core-leader return comparison is measurable only when historical point-in-time policy evidence and explicit theme-leadership evidence exist. Current industry labels, price leadership, or later news are not substituted for missing historical evidence.'
  };
  summary.coreSelectionTop5 = coreSelectionTop5;
  summary.preBreakoutTop10 = preBreakoutTop10;
  summary.preBreakoutTop15 = preBreakoutTop15;
  const preBreakoutEvaluation = {
    status: eligibleDates.length >= 3 && preBreakoutReturnedRows > 0 ? 'MEASURABLE' : 'NOT_MEASURABLE',
    signalDateCount: eligibleDates.length,
    returnedCandidateRows: preBreakoutReturnedRows,
    verifiedLeaderRows: preBreakoutLeaderRows,
    policyVerifiedRows: preBreakoutPolicyRows,
    top10: preBreakoutTop10,
    top15: preBreakoutTop15,
    reasons: [
      ...(eligibleDates.length < 3 ? ['fewer-than-three-complete-forward-evaluation-dates'] : []),
      ...(preBreakoutReturnedRows === 0 ? ['no-pre-breakout-candidates-passed-the-strict-watch-gates'] : []),
      ...(preBreakoutLeaderRows === 0 ? ['no-verified-point-in-time-leader-evidence-in-pre-breakout-watch'] : []),
      ...(preBreakoutPolicyRows === 0 ? ['no-verified-point-in-time-policy-evidence-in-pre-breakout-watch'] : [])
    ],
    interpretation: 'Measures forward outcomes of pre-breakout watch candidates; it is not a probability model and does not authorize trading.'
  };
  const modelTop10T5 = summary.top10?.model?.t5 ?? {};
  const baselineTop10T5 = summary.top10?.momentumBaseline?.t5 ?? {};
  const balancedTop10T5 = summary.top10?.balancedBlend?.t5 ?? {};
  const promotionReasons = [];
  if (!coreSelectionMeasurable) promotionReasons.push('strict-core-leader-evaluation-not-measurable');
  if (eligibleDates.length < 100) promotionReasons.push('fewer-than-100-out-of-sample-signal-dates');
  if (!Number.isFinite(modelTop10T5.meanCloseReturnPct)
      || !Number.isFinite(baselineTop10T5.meanCloseReturnPct)) {
    promotionReasons.push('model-or-momentum-baseline-t5-return-unavailable');
  } else if (modelTop10T5.meanCloseReturnPct <= baselineTop10T5.meanCloseReturnPct) {
    promotionReasons.push('primary-model-does-not-beat-momentum-baseline-on-mean-t5-return');
  }
  if (Number.isFinite(modelTop10T5.meanWinRatePct) && Number.isFinite(baselineTop10T5.meanWinRatePct)
      && modelTop10T5.meanWinRatePct < baselineTop10T5.meanWinRatePct) {
    promotionReasons.push('primary-model-win-rate-below-momentum-baseline');
  }
  const promotionGate = {
    status: promotionReasons.length === 0 ? 'ELIGIBLE_FOR_INDEPENDENT_REVIEW' : 'HOLD_RESEARCH_ONLY',
    productionAuthorized: false,
    reasons: [...new Set(promotionReasons)],
    signalDateCount: eligibleDates.length,
    minimumRequiredSignalDates: 100,
    strictCoreLeaderMeasurable: coreSelectionMeasurable,
    primaryModelTop10T5MeanReturnPct: Number.isFinite(modelTop10T5.meanCloseReturnPct) ? modelTop10T5.meanCloseReturnPct : null,
    momentumBaselineTop10T5MeanReturnPct: Number.isFinite(baselineTop10T5.meanCloseReturnPct) ? baselineTop10T5.meanCloseReturnPct : null,
    balancedBlendTop10T5MeanReturnPct: Number.isFinite(balancedTop10T5.meanCloseReturnPct) ? balancedTop10T5.meanCloseReturnPct : null,
    note: 'This is a research promotion gate, not a buy signal. Passing it only permits independent review; production deployment and live orders require separate authorization.'
  };
  return {
    model: 'V13-limitup-precursor-walk-forward',
    status: measurable ? 'MEASURABLE' : 'NOT_MEASURABLE',
    measurable,
    reasons: [...new Set(reasons)],
    dataPolicy: {
      features: 'For each signalDate, K-line and fund-flow rows are sliced to dates <= signalDate before scoring; sector context is rebuilt from those pre-signal bars only',
      outcomes: 'Only rows strictly after signalDate are used to calculate T+1/T+3/T+5 close returns, limit-up hits, maximum favorable excursion, and maximum adverse excursion',
      baseline: 'Five-trading-session momentum ranking on the same scored candidate universe',
      variants: 'Compare legacy blended, core-only, early-turn, momentum-led hybrid, cross-sectional momentum-confirmed ranking, V12 Early Opportunity, a 50/50 interleaved momentum/early-opportunity shortlist, and the strict four-layer core-leader selector; emotion-repair and oversold scores remain separate observation lanes',
      policyAndLeaderEvidence: 'Historical core selection uses only pointInTimeIndustry, pointInTimeThemeNames, timestamped companyNews, and pointInTimeLeaderEvidence. Current industry metadata remains available for sector-return diagnostics but cannot be treated as historical policy or theme-leader proof.',
      policyCatalog: 'The current policy taxonomy is unavailable before its recorded review timestamp; historical dates before the catalog review receive no policy-theme match.',
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
    coreSelectionEvaluation,
    preBreakoutEvaluation,
    promotionGate,
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
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    model: report.model, status: report.status, reasons: report.reasons,
    sourceCoveragePct: report.sourceCoveragePct, candidateCount: report.candidateCount,
    signalDateCount: report.signalDateCount, signalDates: report.signalDates,
    summary: report.summary, coreSelectionEvaluation: report.coreSelectionEvaluation,
    preBreakoutEvaluation: report.preBreakoutEvaluation,
    promotionGate: report.promotionGate
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
