import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rankCandidates } from './precursor_score.js';
import { addHistoricalIndustryContext, isTrueLimitUpOutcome } from './historical_replay.js';
import { evaluateCandidateOutcome, readNdjson } from './walk_forward_eval.js';

const HORIZONS = [1, 3, 5];
const TOP_KS = [10, 30];
const FEATURE_NAMES = [
  'r3Pct', 'r5Pct', 'r10Pct', 'distHigh20Pct', 'distLow20Pct',
  'recentLimitUp5Count', 'recentLimitUp10Count', 'recentStrongUp10Count',
  'volumeExpansion', 'priorVolumeCompression', 'mainNet5SignedLog',
  'mainFlowRatioPct', 'amountLog', 'turnoverRate', 'currentPct', 'riskPenalty',
  'trendScore', 'volumePriceScore', 'flowScore', 'sectorScore', 'momentumScore', 'baseScore',
  'earlyTurnScore', 'emotionRepairScore', 'oversoldReversalScore',
  'industryReturn3Pct', 'industryReturn5Pct', 'industryUpRatio', 'industryLeaderScore',
  'industryLimitUpCountLog', 'isMainBoard', 'isChiNext', 'isSTAR', 'isBeijing'
];

function parseArgs(argv) {
  const out = {
    input: 'output/v13-history-replay/replay_candidates.ndjson',
    qualityReport: 'output/v13-history-replay/replay_report.json',
    targets: 'research/v13-limitup-precursor/target_symbols.json',
    output: 'output/v13-history-replay/supervised_report.json',
    signalDays: 60
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (argv[i] === '--quality-report' && argv[i + 1]) out.qualityReport = argv[++i];
    else if (argv[i] === '--targets' && argv[i + 1]) out.targets = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) out.output = argv[++i];
    else if (argv[i] === '--signal-days' && argv[i + 1]) out.signalDays = Math.max(15, Math.min(60, Number(argv[++i]) || 25));
  }
  return out;
}

function num(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}
function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}
function logSigned(value) {
  const x = num(value);
  return x === null ? null : Math.sign(x) * Math.log1p(Math.abs(x));
}
function logPositive(value) {
  const x = num(value);
  return x === null || x < 0 ? null : Math.log1p(x);
}
function boardFeatures(board) {
  return [
    board === 'SH_MAIN' || board === 'SZ_MAIN' ? 1 : 0,
    board === 'CHINEXT' ? 1 : 0,
    board === 'STAR' ? 1 : 0,
    board === 'BSE' ? 1 : 0
  ];
}
export function extractFeatureVector(row) {
  const f = row.features ?? {};
  const c = row.components ?? {};
  const s = row.sector ?? {};
  return [
    num(f.r3Pct), num(f.r5Pct), num(f.r10Pct), num(f.distHigh20Pct), num(f.distLow20Pct),
    num(f.recentLimitUp5Count), num(f.recentLimitUp10Count), num(f.recentStrongUp10Count),
    num(f.volumeExpansion), num(f.priorVolumeCompression), logSigned(f.mainNet5),
    num(f.mainFlowRatioPct), logPositive(f.amount), num(f.turnoverRate), num(row.currentPct), num(row.riskPenalty),
    num(c.trend), num(c.volumePrice), num(c.flow), num(c.sector), num(c.momentum), num(c.base),
    num(c.earlyTurn), num(c.emotionRepair), num(c.oversoldReversal),
    num(s.return3Pct), num(s.return5Pct), num(s.upRatio), num(s.leaderScore), logPositive(s.limitUpCount),
    ...boardFeatures(row.board)
  ];
}

function fitStandardizer(samples) {
  const width = FEATURE_NAMES.length;
  const means = new Array(width).fill(0);
  const stds = new Array(width).fill(1);
  for (let j = 0; j < width; j++) {
    const values = samples.map(sample => sample.x[j]).filter(Number.isFinite);
    means[j] = mean(values) ?? 0;
    const variance = mean(values.map(value => (value - means[j]) ** 2)) ?? 1;
    stds[j] = Math.sqrt(variance) > 1e-8 ? Math.sqrt(variance) : 1;
  }
  return { means, stds };
}
function standardize(vector, standardizer) {
  return vector.map((value, j) => {
    if (!Number.isFinite(value)) return 0;
    const scaled = (value - standardizer.means[j]) / standardizer.stds[j];
    return Math.max(-6, Math.min(6, scaled));
  });
}
function sigmoid(value) {
  const x = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-x));
}

export function trainLogisticRegression(samples, {
  epochs = 60, learningRate = 0.08, l2 = 0.05, positiveWeight = null
} = {}) {
  if (!Array.isArray(samples) || samples.length < 100) throw new Error('insufficient training samples');
  const positives = samples.filter(sample => sample.y === 1).length;
  const negatives = samples.length - positives;
  if (!positives || !negatives) throw new Error('training labels require both classes');
  const standardizer = fitStandardizer(samples);
  const xs = samples.map(sample => standardize(sample.x, standardizer));
  const ys = samples.map(sample => sample.y);
  const classWeight = positiveWeight ?? Math.min(8, Math.sqrt(negatives / positives));
  const weights = new Array(FEATURE_NAMES.length + 1).fill(0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array(weights.length).fill(0);
    for (let i = 0; i < xs.length; i++) {
      let z = weights[0];
      const x = xs[i];
      for (let j = 0; j < x.length; j++) z += weights[j + 1] * x[j];
      const sampleWeight = ys[i] === 1 ? classWeight : 1;
      const error = (sigmoid(z) - ys[i]) * sampleWeight;
      gradient[0] += error;
      for (let j = 0; j < x.length; j++) gradient[j + 1] += error * x[j];
    }
    const rate = learningRate / (1 + epoch * 0.015);
    for (let j = 0; j < weights.length; j++) {
      let g = gradient[j] / xs.length;
      if (j > 0) g += l2 * weights[j];
      weights[j] -= rate * g;
    }
  }
  return {
    featureNames: [...FEATURE_NAMES],
    standardizer,
    weights,
    trainingSamples: samples.length,
    positiveSamples: positives,
    negativeSamples: negatives,
    positiveWeight: classWeight,
    epochs, learningRate, l2
  };
}

export function predictProbability(model, vector) {
  const x = standardize(vector, model.standardizer);
  let z = model.weights[0];
  for (let j = 0; j < x.length; j++) z += model.weights[j + 1] * x[j];
  return sigmoid(z);
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
export function buildPointInTimeRows(rawCandidates, signalDate) {
  const preCutoff = rawCandidates.map(stock => ({
    ...stock,
    asOf: signalDate,
    bars: datedBars(stock).filter(bar => bar.date <= signalDate),
    flows: (Array.isArray(stock.flows) ? stock.flows : [])
      .filter(flow => /^\d{4}-\d{2}-\d{2}$/.test(String(flow?.date ?? '')) && flow.date <= signalDate)
  })).filter(stock => stock.bars.length >= 25);
  const contextual = addHistoricalIndustryContext(preCutoff);
  const byCode = new Map(contextual.map(stock => [String(stock.code), stock]));
  const enriched = contextual.map(stock => {
    const latest = stock.bars.at(-1);
    return {
      ...stock,
      isST: Boolean(stock.isST) || /ST|退/i.test(String(stock.name ?? '')),
      amount: latest?.amount,
      turnoverRate: latest?.turnoverRate
    };
  });
  const ranked = rankCandidates(enriched, { asOf: signalDate, modelVariant: 'v13-core-only' });
  return ranked.map(row => ({ ...row, sector: byCode.get(String(row.code))?.sector ?? {} }));
}
function trainingSamplesForDate(rawCandidates, signalDate, rawByCode) {
  const rows = buildPointInTimeRows(rawCandidates, signalDate);
  const samples = [];
  for (const row of rows) {
    const raw = rawByCode.get(String(row.code));
    if (!raw) continue;
    const outcome = evaluateCandidateOutcome(raw, signalDate);
    if (!outcome || !Number.isFinite(outcome.t5CloseReturnPct) || typeof outcome.limitUpWithin5 !== 'boolean') continue;
    samples.push({
      code: String(row.code), name: row.name, signalDate,
      x: extractFeatureVector(row),
      yLimitUp: outcome.limitUpWithin5 ? 1 : 0,
      yPositiveReturn5: outcome.t5CloseReturnPct >= 3 ? 1 : 0,
      t5CloseReturnPct: outcome.t5CloseReturnPct
    });
  }
  return { rows, samples };
}

function rankMetrics(rankedCodes, k, universeCodes, outcomeByCode) {
  const topRows = rankedCodes.slice(0, k).map(code => outcomeByCode.get(String(code)))
    .filter(Boolean);
  const metrics = {};
  for (const horizon of HORIZONS) {
    const returnKey = 't' + horizon + 'CloseReturnPct';
    const hitKey = 'limitUpWithin' + horizon;
    const validTop = topRows.filter(row => Number.isFinite(row[returnKey]));
    const validUniverse = universeCodes.map(code => outcomeByCode.get(String(code)))
      .filter(row => row && Number.isFinite(row[returnKey]));
    const hitCount = validTop.filter(row => row[hitKey] === true).length;
    const universeHits = validUniverse.filter(row => row[hitKey] === true).length;
    const returns = validTop.map(row => row[returnKey]);
    const riskRows = validTop.filter(row => Number.isFinite(row.maxHighReturn5Pct) && Number.isFinite(row.maxAdverseExcursion5Pct));
    metrics['t' + horizon] = {
      evaluatedTopCount: validTop.length,
      universeOutcomeCount: validUniverse.length,
      universeLimitUpCount: universeHits,
      limitUpHitCount: hitCount,
      limitUpPrecisionPct: validTop.length ? Number((hitCount / validTop.length * 100).toFixed(2)) : null,
      positiveReturnPrecisionPct: validTop.length ? Number((validTop.filter(row => row[returnKey] >= 3).length / validTop.length * 100).toFixed(2)) : null,
      limitUpRecallPct: universeHits ? Number((hitCount / universeHits * 100).toFixed(2)) : null,
      meanCloseReturnPct: mean(returns) === null ? null : Number(mean(returns).toFixed(2)),
      winRatePct: validTop.length ? Number((validTop.filter(row => row[returnKey] > 0).length / validTop.length * 100).toFixed(2)) : null,
      meanMaxHighReturn5Pct: riskRows.length ? Number(mean(riskRows.map(row => row.maxHighReturn5Pct)).toFixed(2)) : null,
      meanMaxAdverseExcursion5Pct: riskRows.length ? Number(mean(riskRows.map(row => row.maxAdverseExcursion5Pct)).toFixed(2)) : null
    };
  }
  return metrics;
}
function aggregateTestMetrics(perDate, rankingKey, topK) {
  const result = {};
  for (const horizon of HORIZONS) {
    const rows = perDate.map(day => day[rankingKey]['top' + topK]['t' + horizon]);
    const avg = key => mean(rows.map(row => row[key]));
    result['t' + horizon] = {
      signalDates: rows.filter(row => Number.isFinite(row.meanCloseReturnPct)).length,
      meanLimitUpPrecisionPct: avg('limitUpPrecisionPct'),
      meanPositiveReturnPrecisionPct: avg('positiveReturnPrecisionPct'),
      meanLimitUpRecallPct: avg('limitUpRecallPct'),
      meanCloseReturnPct: avg('meanCloseReturnPct'),
      meanWinRatePct: avg('winRatePct'),
      meanMaxHighReturn5Pct: avg('meanMaxHighReturn5Pct'),
      meanMaxAdverseExcursion5Pct: avg('meanMaxAdverseExcursion5Pct')
    };
    for (const key of Object.keys(result['t' + horizon])) {
      if (key === 'signalDates') continue;
      const value = result['t' + horizon][key];
      result['t' + horizon][key] = Number.isFinite(value) ? Number(value.toFixed(2)) : null;
    }
  }
  return result;
}

function scoreDateRows(rows, model) {
  return rows.map(row => ({
    code: String(row.code), name: row.name,
    probability: predictProbability(model, extractFeatureVector(row)),
    r5Pct: row.features?.r5Pct ?? null,
    coreScore: row.score,
    row
  }));
}
function outcomesForCodes(rawByCode, codes, signalDate) {
  const map = new Map();
  for (const code of codes) {
    const stock = rawByCode.get(String(code));
    if (stock) {
      const outcome = evaluateCandidateOutcome(stock, signalDate);
      if (outcome) map.set(String(code), outcome);
    }
  }
  return map;
}
function summarizeImportance(model) {
  return model.featureNames.map((name, index) => ({
    feature: name,
    standardizedCoefficient: Number(model.weights[index + 1].toFixed(4))
  })).sort((a, b) => Math.abs(b.standardizedCoefficient) - Math.abs(a.standardizedCoefficient));
}

export function splitSignalDates(eligibleDates) {
  const dates = Array.isArray(eligibleDates) ? eligibleDates : [];
  const purgeWindow = 5;
  const testWindow = dates.length >= 45 ? 15 : 5;
  const trainCount = Math.max(0, dates.length - purgeWindow - testWindow);
  return {
    trainDates: dates.slice(0, trainCount),
    purgeDates: dates.slice(trainCount, trainCount + purgeWindow),
    testDates: dates.slice(trainCount + purgeWindow),
    purgeWindow, testWindow
  };
}

export function evaluateSupervisedRanker(rawCandidates, {
  sourceCoveragePct = null,
  targets = [],
  asOf = null,
  signalDays = 60
} = {}) {
  const rows = Array.isArray(rawCandidates) ? rawCandidates : [];
  const rawByCode = new Map(rows.map(stock => [String(stock.code), { ...stock, bars: datedBars(stock) }]));
  const allDates = [...new Set([...rawByCode.values()].flatMap(stock => stock.bars.map(bar => bar.date)))].sort();
  const eligibleDates = allDates.slice(0, Math.max(0, allDates.length - 5)).slice(-signalDays);
  if (eligibleDates.length < 15) {
    return {
      model: 'V13-supervised-limitup-ranker',
      status: 'NOT_MEASURABLE', measurable: false,
      reasons: ['fewer-than-15-complete-signal-dates'],
      availableSignalDates: eligibleDates.length, sourceCoveragePct
    };
  }
  const { trainDates, purgeDates, testDates, purgeWindow, testWindow } = splitSignalDates(eligibleDates);
  const samplesByDate = new Map();
  const featureRowsByDate = new Map();
  const dataDiagnostics = [];
  for (const date of eligibleDates) {
    const built = trainingSamplesForDate(rows, date, rawByCode);
    samplesByDate.set(date, built.samples);
    featureRowsByDate.set(date, built.rows);
    dataDiagnostics.push({
      date, scoredRows: built.rows.length, labeledSamples: built.samples.length,
      positiveLabels: built.samples.filter(sample => sample.yLimitUp === 1).length,
      positiveReturnLabels: built.samples.filter(sample => sample.yPositiveReturn5 === 1).length
    });
  }
  const trainSamples = trainDates.flatMap(date => samplesByDate.get(date) ?? []);
  const model = trainLogisticRegression(
    trainSamples.map(sample => ({ x: sample.x, y: sample.yLimitUp })), { epochs: 35 }
  );
  const positiveReturnModel = trainLogisticRegression(
    trainSamples.map(sample => ({ x: sample.x, y: sample.yPositiveReturn5 })), { epochs: 35 }
  );
  const perDate = [];
  for (const date of testDates) {
    const rowsAtDate = featureRowsByDate.get(date) ?? [];
    const supervised = scoreDateRows(rowsAtDate, model).sort((a, b) => b.probability - a.probability || b.coreScore - a.coreScore);
    const positiveReturn = scoreDateRows(rowsAtDate, positiveReturnModel).sort((a, b) => b.probability - a.probability || b.coreScore - a.coreScore);
    const momentum = [...rowsAtDate].sort((a, b) =>
      (Number.isFinite(b.features?.r5Pct) ? b.features.r5Pct : -Infinity) -
      (Number.isFinite(a.features?.r5Pct) ? a.features.r5Pct : -Infinity) || b.score - a.score);
    const core = [...rowsAtDate].sort((a, b) => b.score - a.score);
    const supervisedCodes = supervised.map(row => row.code);
    const positiveReturnCodes = positiveReturn.map(row => row.code);
    const momentumCodes = momentum.map(row => row.code);
    const coreCodes = core.map(row => row.code);
    const outcomeByCode = outcomesForCodes(rawByCode, [...new Set([...supervisedCodes, ...positiveReturnCodes, ...momentumCodes, ...coreCodes])], date);
    const universeCodes = supervisedCodes.filter(code => outcomeByCode.has(String(code)));
    const day = {
      signalDate: date,
      scoredUniverseCount: supervisedCodes.length,
      trainingSamples: trainSamples.length,
      supervisedTop10Codes: supervisedCodes.slice(0, 10),
      positiveReturnTop10Codes: positiveReturnCodes.slice(0, 10),
      momentumTop10Codes: momentumCodes.slice(0, 10),
      coreTop10Codes: coreCodes.slice(0, 10),
      supervised: {}, positiveReturn: {}, momentumBaseline: {}, coreOnly: {}
    };
    for (const k of TOP_KS) {
      day.supervised['top' + k] = rankMetrics(supervisedCodes, k, universeCodes, outcomeByCode);
      day.positiveReturn['top' + k] = rankMetrics(positiveReturnCodes, k, universeCodes, outcomeByCode);
      day.momentumBaseline['top' + k] = rankMetrics(momentumCodes, k, universeCodes, outcomeByCode);
      day.coreOnly['top' + k] = rankMetrics(coreCodes, k, universeCodes, outcomeByCode);
    }
    perDate.push(day);
  }
  const summary = {};
  for (const k of TOP_KS) {
    summary['top' + k] = {
      supervised: aggregateTestMetrics(perDate, 'supervised', k),
      positiveReturn: aggregateTestMetrics(perDate, 'positiveReturn', k),
      momentumBaseline: aggregateTestMetrics(perDate, 'momentumBaseline', k),
      coreOnly: aggregateTestMetrics(perDate, 'coreOnly', k)
    };
  }

  const fitSamples = eligibleDates.flatMap(date => samplesByDate.get(date) ?? []);
  const finalModel = trainLogisticRegression(
    fitSamples.map(sample => ({ x: sample.x, y: sample.yLimitUp })), { epochs: 35 }
  );
  const finalPositiveReturnModel = trainLogisticRegression(
    fitSamples.map(sample => ({ x: sample.x, y: sample.yPositiveReturn5 })), { epochs: 35 }
  );
  const holdoutDate = asOf || allDates.at(-1);
  const holdoutRows = buildPointInTimeRows(rows, holdoutDate);
  const holdoutRanked = scoreDateRows(holdoutRows, finalModel)
    .sort((a, b) => b.probability - a.probability || b.coreScore - a.coreScore);
  const positiveReturnHoldoutRanked = scoreDateRows(holdoutRows, finalPositiveReturnModel)
    .sort((a, b) => b.probability - a.probability || b.coreScore - a.coreScore);
  const holdoutByCode = new Map(holdoutRanked.map((row, index) => [row.code, { ...row, rank: index + 1 }]));
  const positiveReturnHoldoutByCode = new Map(positiveReturnHoldoutRanked.map((row, index) => [row.code, { ...row, rank: index + 1 }]));
  const holdoutTargets = targets.filter(target => !target.signalDate || target.signalDate === holdoutDate)
    .map(target => {
      const hit = holdoutByCode.get(String(target.code));
      const positiveHit = positiveReturnHoldoutByCode.get(String(target.code));
      return {
        code: String(target.code), name: target.name, knownOutcome: target.outcome ?? null,
        isTrueLimitUp: isTrueLimitUpOutcome(target.outcome),
        rank: hit?.rank ?? null,
        inTop10: hit ? hit.rank <= 10 : null,
        inTop30: hit ? hit.rank <= 30 : null,
        probability: hit ? Number(hit.probability.toFixed(6)) : null,
        positiveReturnRank: positiveHit?.rank ?? null,
        positiveReturnInTop10: positiveHit ? positiveHit.rank <= 10 : null,
        positiveReturnInTop30: positiveHit ? positiveHit.rank <= 30 : null,
        positiveReturnProbability: positiveHit ? Number(positiveHit.probability.toFixed(6)) : null,
        featureSnapshot: hit ? Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, extractFeatureVector(hit.row)[i]])) : null
      };
    });
  const missingTargets = holdoutTargets.filter(target => target.rank === null || target.positiveReturnRank === null).map(target => target.code);
  const coverage = Number.isFinite(Number(sourceCoveragePct)) ? Number(sourceCoveragePct) : null;
  const reasons = [];
  if (coverage === null) reasons.push('source-bar-coverage-missing');
  else if (coverage < 90) reasons.push('historical-bar-coverage-below-90pct');
  if (testDates.length < 3) reasons.push('fewer-than-three-test-dates');
  if (model.positiveSamples < 100) reasons.push('too-few-positive-limit-up-training-labels');
  if (finalPositiveReturnModel.positiveSamples < 100) reasons.push('too-few-positive-return-training-labels');
  if (missingTargets.length) reasons.push('one-or-more-holdout-targets-not-scored-by-both-models');
  const measurable = reasons.length === 0;
  return {
    model: 'V13-supervised-dual-objective-ranker',
    status: measurable ? 'MEASURABLE' : 'NOT_MEASURABLE',
    measurable,
    reasons,
    objective: 'Compare a five-session limit-up classifier with a separate positive-forward-return classifier',
    label: 'Limit-up task: limitUpWithin5. Positive-return task: T+5 close return >= 3%. All labels use bars strictly after each signal date.',
    split: {
      eligibleDates, trainDates, purgeDates, testDates, purgeWindow, testWindow,
      leakageGuard: 'Each training label horizon ends within the purge block or earlier; all test dates begin after the purge block and after every training label horizon'
    },
    sourceCoveragePct: coverage,
    candidateCount: rows.length,
    trainingSamples: model.trainingSamples,
    positiveTrainingLabels: model.positiveSamples,
    negativeTrainingLabels: model.negativeSamples,
    positiveLabelRatePct: Number((model.positiveSamples / Math.max(1, model.trainingSamples) * 100).toFixed(3)),
    positiveReturnTrainingLabels: finalPositiveReturnModel.positiveSamples,
    negativeReturnTrainingLabels: finalPositiveReturnModel.negativeSamples,
    positiveReturnLabelRatePct: Number((finalPositiveReturnModel.positiveSamples / Math.max(1, finalPositiveReturnModel.trainingSamples) * 100).toFixed(3)),
    featureCount: FEATURE_NAMES.length,
    featureImportance: summarizeImportance(finalModel),
    positiveReturnFeatureImportance: summarizeImportance(finalPositiveReturnModel),
    testSummary: summary,
    testPerDate: perDate,
    collectionDiagnostics: dataDiagnostics,
    holdout: {
      asOf: holdoutDate,
      scoredCount: holdoutRanked.length,
      targetCount: holdoutTargets.length,
      targetScoredCount: holdoutTargets.length - missingTargets.length,
      missingTargets,
      trueLimitUpTargetCount: holdoutTargets.filter(target => target.isTrueLimitUp).length,
      trueLimitUpTargetsTop10: measurable ? holdoutTargets.filter(target => target.isTrueLimitUp && target.inTop10).length : null,
      trueLimitUpTargetsTop30: measurable ? holdoutTargets.filter(target => target.isTrueLimitUp && target.inTop30).length : null,
      positiveReturnModelTrueLimitUpTargetsTop10: measurable ? holdoutTargets.filter(target => target.isTrueLimitUp && target.positiveReturnInTop10).length : null,
      positiveReturnModelTrueLimitUpTargetsTop30: measurable ? holdoutTargets.filter(target => target.isTrueLimitUp && target.positiveReturnInTop30).length : null,
      targets: holdoutTargets,
      top10: holdoutRanked.slice(0, 10).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, probability: Number(row.probability.toFixed(6)), coreScore: row.coreScore })),
      top30: holdoutRanked.slice(0, 30).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, probability: Number(row.probability.toFixed(6)), coreScore: row.coreScore })),
      positiveReturnTop10: positiveReturnHoldoutRanked.slice(0, 10).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, probability: Number(row.probability.toFixed(6)), coreScore: row.coreScore })),
      positiveReturnTop30: positiveReturnHoldoutRanked.slice(0, 30).map((row, index) => ({ rank: index + 1, code: row.code, name: row.name, probability: Number(row.probability.toFixed(6)), coreScore: row.coreScore }))
    }
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const rawCandidates = await readNdjson(resolve(args.input));
  const qualityReport = JSON.parse(await readFile(resolve(args.qualityReport), 'utf8'));
  const targetsFile = JSON.parse(await readFile(resolve(args.targets), 'utf8'));
  const targets = (Array.isArray(targetsFile.targets) ? targetsFile.targets : []);
  const report = evaluateSupervisedRanker(rawCandidates, {
    sourceCoveragePct: qualityReport.coverage?.barCoveragePct,
    targets, asOf: qualityReport.asOf, signalDays: args.signalDays
  });
  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    model: report.model, status: report.status, reasons: report.reasons,
    sourceCoveragePct: report.sourceCoveragePct, trainingSamples: report.trainingSamples,
    positiveTrainingLabels: report.positiveTrainingLabels,
    positiveReturnTrainingLabels: report.positiveReturnTrainingLabels,
    testSummary: report.testSummary,
    holdout: report.holdout && {
      asOf: report.holdout.asOf, targetCount: report.holdout.targetCount,
      targetScoredCount: report.holdout.targetScoredCount,
      trueLimitUpTargetCount: report.holdout.trueLimitUpTargetCount,
      trueLimitUpTargetsTop10: report.holdout.trueLimitUpTargetsTop10,
      trueLimitUpTargetsTop30: report.holdout.trueLimitUpTargetsTop30,
      positiveReturnModelTrueLimitUpTargetsTop10: report.holdout.positiveReturnModelTrueLimitUpTargetsTop10,
      positiveReturnModelTrueLimitUpTargetsTop30: report.holdout.positiveReturnModelTrueLimitUpTargetsTop30,
      targets: report.holdout.targets.map(row => ({
        code: row.code, limitUpRank: row.rank, positiveReturnRank: row.positiveReturnRank,
        probability: row.probability, positiveReturnProbability: row.positiveReturnProbability, knownOutcome: row.knownOutcome
      }))
    }
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
