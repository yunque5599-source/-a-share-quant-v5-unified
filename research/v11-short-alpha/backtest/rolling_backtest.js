import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, round, asOfDate } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';

export const ROLLING_SCHEMA = 'v11-short-alpha-rolling-backtest-v1';
export const DEFAULT_ROLLING_HORIZONS = Object.freeze([1, 3, 5]);
export const DEFAULT_TOP_NS = Object.freeze([1, 5]);

const list = value => Array.isArray(value) ? value : [];
const number = value => finiteNumber(value);
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);

function snapshotsOf(input) {
  if (Array.isArray(input?.predictions)) return input.predictions;
  if (Array.isArray(input?.snapshots)) return input.snapshots;
  const snapshot = input?.prediction ?? input?.alphaResult ?? input?.result ?? input;
  return snapshot && typeof snapshot === 'object' ? [snapshot] : [];
}

function rankingOf(snapshot) {
  return list(snapshot?.ranking ?? snapshot?.candidates ?? snapshot?.stocks);
}

function snapshotDate(snapshot) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
}

function normalizePositiveIntegers(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  const normalized = [...new Set(values.map(number)
    .filter(value => Number.isInteger(value) && value > 0))];
  return normalized.length ? normalized.sort((a, b) => a - b) : [...fallback];
}

function trainingProfile(training, selectionScore = 'alpha') {
  const candidates = training.flatMap(snapshot => rankingOf(snapshot));
  const scores = candidates.map(candidate =>
    number(candidate?.scores?.alpha ?? candidate?.alphaScore ?? candidate?.score)
  ).filter(value => value !== null);
  const topScores = training.map(snapshot => number(rankingOf(snapshot)[0]?.scores?.alpha))
    .filter(value => value !== null);
  return {
    snapshotCount: training.length,
    candidateCount: candidates.length,
    meanAlpha: metric(mean(scores)),
    meanTop1Alpha: metric(mean(topScores)),
    adjustment: 'none',
    selectionScore,
    timingVersion: selectionScore === 'alpha' ? null : 'V11 Buy Timing Phase 1',
    weights: 'fixed-v11-alpha-30-25-20-15-10'
  };
}

function maxDrawdown(trades) {
  if (!trades.length) return null;
  const grouped = new Map();
  for (const trade of trades) {
    const values = grouped.get(trade.entryDate) ?? [];
    values.push(trade.returnPct);
    grouped.set(trade.entryDate, values);
  }
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const date of [...grouped.keys()].sort()) {
    equity *= 1 + mean(grouped.get(date)) / 100;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  }
  return drawdown;
}

function payoffRatio(returns) {
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  if (!losses.length) return null;
  if (!wins.length) return 0;
  return mean(wins) / Math.abs(mean(losses));
}

export function summarizeTrades(trades = []) {
  const valid = trades.filter(trade => trade.status === 'ok');
  const returns = valid.map(trade => trade.returnPct);
  const wins = returns.filter(value => value > 0);
  return {
    tradeCount: valid.length,
    unavailable: trades.length - valid.length,
    averageReturnPct: metric(mean(returns)),
    winRatePct: valid.length ? metric(wins.length / valid.length * 100) : null,
    maxDrawdownPct: metric(maxDrawdown(valid)),
    payoffRatio: metric(payoffRatio(returns))
  };
}

function foldDates(snapshots) {
  return {
    start: snapshots[0] ? snapshotDate(snapshots[0]) : null,
    end: snapshots.at(-1) ? snapshotDate(snapshots.at(-1)) : null,
    count: snapshots.length
  };
}

/**
 * Walk forward through captured Alpha snapshots. Training windows are used only
 * to record the historical calibration profile; V11 weights remain fixed. Each
 * validation window is passed to the existing replay engine without future rows
 * from later snapshots being used to select candidates.
 */
export function rollingBacktest(input = {}, options = {}) {
  const rawSnapshots = snapshotsOf(input);
  const diagnostics = {
    inputSnapshotCount: rawSnapshots.length,
    invalidSnapshotDates: 0,
    duplicateSnapshotDates: 0,
    skippedPartialFold: 0,
    validationSnapshotCount: 0,
    trainingSnapshotCount: 0
  };
  const dated = [];
  const seenDates = new Set();
  rawSnapshots.forEach((snapshot, index) => {
    const date = snapshotDate(snapshot);
    if (!date) {
      diagnostics.invalidSnapshotDates += 1;
      return;
    }
    if (seenDates.has(date)) {
      diagnostics.duplicateSnapshotDates += 1;
      return;
    }
    seenDates.add(date);
    dated.push({ snapshot, date, index });
  });
  dated.sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
  const snapshots = dated.map(item => item.snapshot);
  const trainSize = Math.max(1, Math.floor(number(options.trainSize) ?? 2));
  const testSize = Math.max(1, Math.floor(number(options.testSize) ?? 1));
  const step = Math.max(1, Math.floor(number(options.step) ?? testSize));
  const requestedHorizons = normalizePositiveIntegers(options.horizons, DEFAULT_ROLLING_HORIZONS)
    .filter(horizon => DEFAULT_ROLLING_HORIZONS.includes(horizon));
  const horizons = requestedHorizons.length ? requestedHorizons : [...DEFAULT_ROLLING_HORIZONS];
  const topNs = normalizePositiveIntegers(options.topNs, DEFAULT_TOP_NS);
  const selectionScore = options.selectionScore ?? 'alpha';
  if (!['alpha', 'timing', 'composite'].includes(selectionScore)) {
    throw new Error('Unknown selectionScore: ' + selectionScore);
  }
  const includePartial = options.includePartial === true;
  const histories = input?.histories ?? input?.historyBySymbol ?? input?.prices ?? {};
  const folds = [];
  const aggregateTrades = Object.fromEntries(topNs.map(topN => [
    'top' + topN,
    Object.fromEntries(horizons.map(horizon => ['T+' + horizon, []]))
  ]));

  for (let start = trainSize; start < snapshots.length; start += step) {
    const training = snapshots.slice(Math.max(0, start - trainSize), start);
    const validation = snapshots.slice(start, start + testSize);
    if (training.length < trainSize || validation.length < testSize) {
      if (validation.length) diagnostics.skippedPartialFold += 1;
      if (!includePartial || !validation.length) continue;
    }
    diagnostics.trainingSnapshotCount += training.length;
    diagnostics.validationSnapshotCount += validation.length;
    const fold = {
      fold: folds.length + 1,
      training: foldDates(training),
      validation: foldDates(validation),
      trainingProfile: trainingProfile(training, selectionScore),
      results: {}
    };
    for (const topN of topNs) {
      const key = 'top' + topN;
      const replay = backtestAlpha(
        { predictions: validation, histories },
        {
          topN,
          horizons,
          includeIncomplete: options.includeIncomplete === true,
          selectionScore,
          roundTripCostBps: options.roundTripCostBps
        }
      );
      fold.results[key] = {};
      for (const horizon of horizons) {
        const horizonKey = 'T+' + horizon;
        const trades = replay.results[horizonKey]?.trades ?? [];
        fold.results[key][horizonKey] = summarizeTrades(trades);
        aggregateTrades[key][horizonKey].push(...trades);
      }
    }
    folds.push(fold);
  }

  const aggregate = {};
  for (const topN of topNs) {
    const key = 'top' + topN;
    aggregate[key] = {};
    for (const horizon of horizons) {
      aggregate[key]['T+' + horizon] = summarizeTrades(aggregateTrades[key]['T+' + horizon]);
    }
  }

  return {
    schema: ROLLING_SCHEMA,
    version: 'V11 Short Alpha Out-of-Sample Rolling Validation',
    config: {
      trainSize, testSize, step, horizons, topNs, selectionScore,
      adjustment: 'none',
      weights: 'fixed-v11-alpha-30-25-20-15-10',
      includePartial
    },
    folds,
    aggregate,
    diagnostics
  };
}

export const runRollingBacktest = rollingBacktest;

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(args) {
  const inputPath = valueAfter(args, '--input');
  if (!inputPath) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/rolling_backtest.js --input FILE');
  }
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const numeric = name => {
    const value = number(valueAfter(args, name));
    return value === null ? undefined : value;
  };
  const result = rollingBacktest(input, {
    trainSize: numeric('--train-size'),
    testSize: numeric('--test-size'),
    step: numeric('--step'),
    selectionScore: valueAfter(args, '--selection-score') ?? 'alpha'
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V11 rolling backtest: ' + error.message);
    process.exitCode = 1;
  });
}
