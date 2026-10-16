import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, asOfDate } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';
import { summarizeTrades } from './rolling_backtest.js';

export const STABILITY_SCHEMA = 'v11-short-alpha-stability-benchmark-v1';
export const BENCHMARK_STRATEGIES = Object.freeze(['random', 'alpha', 'composite']);
export const BENCHMARK_HORIZONS = Object.freeze([1, 3, 5]);
export const BENCHMARK_TOP_NS = Object.freeze([1, 5]);

const list = value => Array.isArray(value) ? value : [];
const number = value => finiteNumber(value);

function snapshotsOf(input) {
  if (Array.isArray(input?.predictions)) return input.predictions;
  if (Array.isArray(input?.snapshots)) return input.snapshots;
  const snapshot = input?.prediction ?? input?.alphaResult ?? input?.result ?? input;
  return snapshot && typeof snapshot === 'object' ? [snapshot] : [];
}

function snapshotDate(snapshot) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
}

function rankingOf(snapshot) {
  return list(snapshot?.ranking ?? snapshot?.candidates ?? snapshot?.stocks);
}

function symbolOf(candidate) {
  return String(candidate?.symbol ?? candidate?.code ?? candidate?.f12 ?? '').trim();
}

function normalize(values, fallback) {
  const requested = Array.isArray(values) ? values : fallback;
  const result = [...new Set(requested.map(number)
    .filter(value => Number.isInteger(value) && value > 0))];
  return result.length ? result.sort((a, b) => a - b) : [...fallback];
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function deterministicShuffle(ranking, seed, date) {
  const canonical = [...ranking].sort((left, right) =>
    symbolOf(left).localeCompare(symbolOf(right))
  );
  return canonical.map((candidate, index) => ({
    candidate, index, key: hash(seed + '|' + date + '|' + symbolOf(candidate))
  })).sort((left, right) => left.key - right.key || left.index - right.index)
    .map(item => item.candidate);
}

function commonUniverse(snapshot) {
  const seen = new Set();
  return rankingOf(snapshot).filter(candidate => {
    const symbol = symbolOf(candidate);
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    return /^\d{6}$/.test(symbol) &&
      candidate?.quality?.complete !== false &&
      number(candidate?.price) > 0 &&
      number(candidate?.scores?.alphaRaw ?? candidate?.scores?.alpha) !== null &&
      number(candidate?.scores?.compositeRaw ?? candidate?.scores?.composite) !== null;
  });
}

function dateRange(snapshots) {
  return {
    start: snapshots[0] ? snapshotDate(snapshots[0]) : null,
    end: snapshots.at(-1) ? snapshotDate(snapshots.at(-1)) : null,
    snapshotCount: snapshots.length
  };
}

function explicitPeriods(input) {
  return list(input?.periods).map((period, index) => ({
    name: String(period?.name ?? 'period-' + (index + 1)),
    start: asOfDate(period?.start ?? period?.from),
    end: asOfDate(period?.end ?? period?.to)
  })).filter(period => period.start && period.end && period.start <= period.end);
}

function buildPeriods(snapshots, input, periodCount) {
  const explicit = explicitPeriods(input);
  if (explicit.length) {
    return explicit.map(period => ({
      ...period,
      snapshots: snapshots.filter(snapshot => {
        const date = snapshotDate(snapshot);
        return date && date >= period.start && date <= period.end;
      })
    }));
  }
  const count = Math.max(1, Math.floor(number(periodCount) ?? 3));
  const size = Math.max(1, Math.ceil(snapshots.length / count));
  const periods = [];
  for (let start = 0; start < snapshots.length; start += size) {
    const group = snapshots.slice(start, start + size);
    periods.push({
      name: 'period-' + (periods.length + 1),
      start: snapshotDate(group[0]),
      end: snapshotDate(group.at(-1)),
      snapshots: group
    });
  }
  return periods;
}

function strategySnapshots(snapshots, strategy, seed) {
  return snapshots.map(snapshot => {
    const universe = commonUniverse(snapshot);
    const ranking = strategy === 'random'
      ? deterministicShuffle(universe, seed, snapshotDate(snapshot))
      : universe;
    return { ...snapshot, ranking };
  });
}

/**
 * Compare deterministic random selection, Alpha selection, and explicit
 * Alpha+Timing composite selection on the same captured universe and future bars.
 */
export function benchmarkStability(input = {}, options = {}) {
  const raw = snapshotsOf(input);
  const diagnostics = {
    inputSnapshotCount: raw.length,
    invalidSnapshotDates: 0,
    duplicateSnapshotDates: 0,
    commonUniverseByPeriod: {}
  };
  const seen = new Set();
  const snapshots = raw.map((snapshot, index) => ({
    snapshot, index, date: snapshotDate(snapshot)
  })).filter(item => {
    if (!item.date) {
      diagnostics.invalidSnapshotDates += 1;
      return false;
    }
    if (seen.has(item.date)) {
      diagnostics.duplicateSnapshotDates += 1;
      return false;
    }
    seen.add(item.date);
    return true;
  }).sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index)
    .map(item => item.snapshot);
  const horizonsRequested = normalize(options.horizons, BENCHMARK_HORIZONS);
  const horizons = horizonsRequested.filter(horizon => BENCHMARK_HORIZONS.includes(horizon));
  const finalHorizons = horizons.length ? horizons : [...BENCHMARK_HORIZONS];
  const topNsRequested = normalize(options.topNs, BENCHMARK_TOP_NS);
  const topNs = topNsRequested.length ? topNsRequested : [...BENCHMARK_TOP_NS];
  const strategies = BENCHMARK_STRATEGIES;
  const seed = String(options.seed ?? input?.seed ?? 'v11-stability-seed');
  const histories = input?.histories ?? input?.historyBySymbol ?? input?.prices ?? {};
  const periods = buildPeriods(snapshots, input, options.periodCount);
  const aggregateTrades = Object.fromEntries(strategies.map(strategy => [
    strategy,
    Object.fromEntries(topNs.map(topN => [
      'top' + topN,
      Object.fromEntries(finalHorizons.map(horizon => ['T+' + horizon, []]))
    ]))
  ]));
  const periodResults = [];

  for (const period of periods) {
    const periodResult = {
      name: period.name,
      range: {start: period.start, end: period.end, snapshotCount: period.snapshots.length},
      commonUniverse: {},
      strategies: {}
    };
    for (const strategy of strategies) {
      const transformed = strategySnapshots(period.snapshots, strategy, seed);
      periodResult.commonUniverse[strategy] = transformed.reduce(
        (sum, snapshot) => sum + commonUniverse(snapshot).length, 0
      );
      periodResult.strategies[strategy] = {};
      const selectionScore = strategy === 'random' ? 'random' : strategy;
      for (const topN of topNs) {
        const key = 'top' + topN;
        const replay = backtestAlpha(
          {predictions: transformed, histories},
          {
            topN, horizons: finalHorizons, selectionScore,
            includeIncomplete: options.includeIncomplete === true,
            roundTripCostBps: options.roundTripCostBps
          }
        );
        periodResult.strategies[strategy][key] = {};
        for (const horizon of finalHorizons) {
          const horizonKey = 'T+' + horizon;
          const trades = replay.results[horizonKey]?.trades ?? [];
          periodResult.strategies[strategy][key][horizonKey] = summarizeTrades(trades);
          aggregateTrades[strategy][key][horizonKey].push(...trades);
        }
      }
    }
    diagnostics.commonUniverseByPeriod[period.name] = periodResult.commonUniverse;
    periodResults.push(periodResult);
  }

  const aggregate = {};
  for (const strategy of strategies) {
    aggregate[strategy] = {};
    for (const topN of topNs) {
      const key = 'top' + topN;
      aggregate[strategy][key] = {};
      for (const horizon of finalHorizons) {
        aggregate[strategy][key]['T+' + horizon] =
          summarizeTrades(aggregateTrades[strategy][key]['T+' + horizon]);
      }
    }
  }

  return {
    schema: STABILITY_SCHEMA,
    version: 'V11 Short Alpha Composite Stability Benchmark',
    config: {
      seed, strategies, horizons: finalHorizons, topNs,
      periodCount: periodResults.length,
      selection: {
        random: 'deterministic-seeded-universe-shuffle',
        alpha: 'scores.alpha',
        composite: 'scores.composite'
      }
    },
    periods: periodResults,
    aggregate,
    diagnostics
  };
}

export const runStabilityBenchmark = benchmarkStability;

async function main(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/stability_benchmark.js --input FILE');
  }
  const input = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
  const seedIndex = args.indexOf('--seed');
  const result = benchmarkStability(input, {
    seed: seedIndex >= 0 ? args[seedIndex + 1] : undefined
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V11 stability benchmark: ' + error.message);
    process.exitCode = 1;
  });
}
