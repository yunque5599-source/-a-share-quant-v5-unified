import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, asOfDate } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';
import { summarizeTrades } from './rolling_backtest.js';

export const V12_BENCHMARK_SCHEMA = 'v12-trade-score-benchmark-v1';
const strategies = ['composite', 'v12'];
const horizons = [1, 3, 5];
const topNs = [1, 5];
const list = value => Array.isArray(value) ? value : [];
const n = value => finiteNumber(value);
const dateOf = snapshot => asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
const rankingOf = snapshot => list(snapshot?.ranking ?? snapshot?.candidates ?? snapshot?.stocks);

function common(snapshot) {
  const seen = new Set();
  return rankingOf(snapshot).filter(candidate => {
    const symbol = String(candidate?.symbol ?? candidate?.code ?? '').trim();
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    return /^\d{6}$/.test(symbol) && candidate?.quality?.complete !== false &&
      n(candidate?.price) > 0 &&
      n(candidate?.scores?.alphaRaw ?? candidate?.scores?.alpha) !== null &&
      n(candidate?.scores?.timingRaw ?? candidate?.scores?.timing) !== null &&
      n(candidate?.scores?.psychologyRaw ?? candidate?.scores?.psychology ??
        candidate?.psychology?.score) !== null;
  });
}

function periodList(input, snapshots) {
  return list(input?.periods).map((period, index) => ({
    name: String(period?.name ?? 'period-' + (index + 1)),
    start: asOfDate(period?.start), end: asOfDate(period?.end)
  })).filter(period => period.start && period.end).map(period => ({
    ...period,
    snapshots: snapshots.filter(snapshot => {
      const date = dateOf(snapshot);
      return date && date >= period.start && date <= period.end;
    })
  }));
}

function metricStore() {
  return Object.fromEntries(strategies.map(strategy => [
    strategy,
    Object.fromEntries(topNs.map(topN => [
      'top' + topN,
      Object.fromEntries(horizons.map(horizon => ['T+' + horizon, []]))
    ]))
  ]));
}

export function benchmarkV12(input = {}) {
  const snapshots = list(input?.predictions).map((snapshot, index) => ({
    snapshot, index, date: dateOf(snapshot)
  })).filter(item => item.date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index)
    .map(item => item.snapshot);
  const histories = input?.histories ?? input?.historyBySymbol ?? input?.prices ?? {};
  const aggregateTrades = metricStore();
  const periodResults = [];

  for (const period of periodList(input, snapshots)) {
    const periodResult = {
      name: period.name,
      range: {start: period.start, end: period.end, snapshotCount: period.snapshots.length},
      strategies: {}
    };
    for (const strategy of strategies) {
      const predictions = period.snapshots.map(snapshot => ({
        ...snapshot, ranking: common(snapshot)
      }));
      const selectionScore = strategy === 'composite' ? 'composite' : 'v12';
      periodResult.strategies[strategy] = {};
      for (const topN of topNs) {
        const key = 'top' + topN;
        const replay = backtestAlpha(
          {predictions, histories}, {topN, selectionScore, horizons}
        );
        periodResult.strategies[strategy][key] = {};
        for (const horizon of horizons) {
          const horizonKey = 'T+' + horizon;
          const trades = replay.results[horizonKey]?.trades ?? [];
          periodResult.strategies[strategy][key][horizonKey] =
            summarizeTrades(trades);
          aggregateTrades[strategy][key][horizonKey].push(...trades);
        }
      }
    }
    periodResults.push(periodResult);
  }

  const aggregate = {};
  for (const strategy of strategies) {
    aggregate[strategy] = {};
    for (const topN of topNs) {
      const key = 'top' + topN;
      aggregate[strategy][key] = {};
      for (const horizon of horizons) {
        aggregate[strategy][key]['T+' + horizon] =
          summarizeTrades(aggregateTrades[strategy][key]['T+' + horizon]);
      }
    }
  }
  return {
    schema: V12_BENCHMARK_SCHEMA,
    version: 'V12 Trade Score Composite Benchmark',
    config: {
      strategies, horizons, topNs,
      formulas: {
        composite: 'Alpha*0.70 + Timing*0.30',
        v12: 'Alpha*0.60 + Timing*0.25 + Psychology*0.15'
      }
    },
    periods: periodResults,
    aggregate
  };
}

export const runV12Benchmark = benchmarkV12;

async function main(args) {
  const index = args.indexOf('--input');
  if (index < 0 || !args[index + 1]) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/v12_benchmark.js --input FILE');
  }
  const input = JSON.parse(await readFile(resolve(args[index + 1]), 'utf8'));
  console.log(JSON.stringify(benchmarkV12(input), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V12 benchmark: ' + error.message);
    process.exitCode = 1;
  });
}
