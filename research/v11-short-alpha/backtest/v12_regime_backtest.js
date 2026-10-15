import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asOfDate, finiteNumber, round } from '../schema.js';
import { backtestAlpha } from './alpha_backtest.js';
import {
  canExecuteBuyNow,
  evaluateRegimeExecution,
  candidateTimingSignal,
  normalizeExecutionAsOf
} from '../market_regime_execution.js';

export const V12_REGIME_GATE_SCHEMA = 'v12-regime-gate-v1';
export const DEFAULT_HORIZONS = Object.freeze([1, 3, 5]);
export const DEFAULT_TOP_NS = Object.freeze([1, 5]);
const REGIMES = Object.freeze(['bull', 'sideways', 'bear', 'unknown']);

const list = value => Array.isArray(value) ? value : [];
const number = value => finiteNumber(value);
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);

function normalizePositiveIntegers(value, fallback, allowed = null) {
  const source = Array.isArray(value) ? value : fallback;
  const normalized = [...new Set(source.map(number)
    .filter(item => Number.isInteger(item) && item > 0 &&
      (!allowed || allowed.includes(item))))];
  return normalized.length ? normalized.sort((a, b) => a - b) : [...fallback];
}

function snapshotsOf(input) {
  if (Array.isArray(input?.predictions)) return input.predictions;
  if (Array.isArray(input?.snapshots)) return input.snapshots;
  const snapshot = input?.prediction ?? input?.alphaResult ?? input?.result ?? input;
  return snapshot && typeof snapshot === 'object' ? [snapshot] : [];
}

function snapshotDate(snapshot) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
}

function foldDates(snapshots) {
  return {
    start: snapshots[0] ? snapshotDate(snapshots[0]) : null,
    end: snapshots.at(-1) ? snapshotDate(snapshots.at(-1)) : null,
    count: snapshots.length
  };
}

function emptyBucket() {
  return { trades: [], periods: [] };
}

function makeStore(topNs, horizons) {
  return Object.fromEntries(['overall', ...REGIMES].map(regime => [
    regime,
    Object.fromEntries(topNs.map(topN => [
      'top' + topN,
      Object.fromEntries(horizons.map(horizon => [
        'T+' + horizon, emptyBucket()
      ]))
    ]))
  ]));
}

function addToStore(store, regime, topN, horizon, trades, period) {
  const key = 'top' + topN;
  const horizonKey = 'T+' + horizon;
  for (const bucketRegime of ['overall', regime]) {
    const bucket = store[bucketRegime][key][horizonKey];
    bucket.trades.push(...trades);
    bucket.periods.push(period);
  }
}

function maxDrawdown(periods, field) {
  if (!periods.length) return null;
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const period of [...periods].sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate))) {
    const value = number(period[field]);
    if (value === null) continue;
    equity *= 1 + value / 100;
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

function metricSummary(bucket, field) {
  const valid = bucket.trades.filter(trade =>
    trade.status === 'ok' && Number.isFinite(trade[field]));
  const rawReturns = valid.map(trade => trade[field]);
  const periods = bucket.periods;
  const periodReturns = periods.map(period => number(period[field]))
    .filter(value => value !== null);
  const activePeriods = periods.filter(period => period.tradeCount > 0)
    .map(period => number(period[field])).filter(value => value !== null);
  const wins = rawReturns.filter(value => value > 0);
  const portfolioWins = activePeriods.filter(value => value > 0);
  let equity = 1;
  for (const value of periodReturns) equity *= 1 + value / 100;
  return {
    sampleCount: valid.length,
    tradeCount: valid.length,
    transactionCount: valid.length,
    observationCount: periods.length,
    skippedObservations: periods.filter(period => period.tradeCount === 0).length,
    averageReturnPct: metric(mean(periodReturns)),
    tradeAverageReturnPct: metric(mean(rawReturns)),
    cumulativeReturnPct: periodReturns.length ? metric((equity - 1) * 100) : null,
    unavailableObservations: periods.length - periodReturns.length,
    winRatePct: valid.length ? metric(wins.length / valid.length * 100) : null,
    portfolioWinRatePct: activePeriods.length
      ? metric(portfolioWins.length / activePeriods.length * 100) : null,
    maxDrawdownPct: metric(maxDrawdown(periods, field)),
    payoffRatio: metric(payoffRatio(rawReturns))
  };
}

function resultFor(bucket) {
  return {
    gross: metricSummary(bucket, 'grossReturnPct'),
    net: metricSummary(bucket, 'returnPct'),
    transactionCount: bucket.trades.filter(trade => trade.status === 'ok').length,
    observationCount: bucket.periods.length,
    skippedObservations: bucket.periods.filter(period => period.tradeCount === 0).length,
    trades: bucket.trades, periods: bucket.periods
  };
}

function emptyPeriod(entryDate, regime, action, exposure, topN, horizon) {
  return {
    entryDate, regime, action, exposure, topN, horizon,
    tradeCount: 0, grossReturnPct: 0, returnPct: 0
  };
}

function cohortPeriod(trades, entryDate, regime, action, exposure, topN, horizon) {
  const valid = trades.filter(trade =>
    trade.status === 'ok' && Number.isFinite(trade.grossReturnPct) &&
    Number.isFinite(trade.returnPct));
  const denominator = topN > 0 ? topN : 1;
  const complete = valid.length === trades.length;
  return {
    entryDate, regime, action, exposure, topN, horizon,
    tradeCount: valid.length,
    grossReturnPct: complete ? valid.reduce((sum, trade) =>
      sum + trade.grossReturnPct * exposure / denominator, 0) : null,
    returnPct: complete ? valid.reduce((sum, trade) =>
      sum + trade.returnPct * exposure / denominator, 0) : null
  };
}

function attachExecution(trade, policy, topN) {
  return {
    ...trade,
    marketRegime: policy.regime,
    executionState: policy.state,
    executionAction: policy.action,
    executionExposure: policy.exposure,
    executionReason: policy.reason,
    plannedTopN: topN
  };
}

/**
 * Compare the existing un-gated V12 replay with a regime execution gate.
 *
 * Baseline and gated mode share BUY_NOW eligibility and original V12 TopN slots.
 * Legacy score replay remains available separately. Gated mode preserves rank,
 * applies a 0.5 exposure and every-second-snapshot cadence in neutral markets,
 * and executes no trades in bear or unknown markets. Empty slots remain cash.
 */
export function benchmarkV12RegimeGate(input = {}, options = {}) {
  const seenDates = new Set();
  let invalidSnapshotDates = 0, duplicateSnapshotDates = 0;
  const dated = snapshotsOf(input).map((snapshot,index)=>({snapshot,index,date:snapshotDate(snapshot)}))
    .filter(item=>{if(!item.date){invalidSnapshotDates++;return false;}if(seenDates.has(item.date)){duplicateSnapshotDates++;return false;}seenDates.add(item.date);return true;})
    .sort((a,b)=>a.date.localeCompare(b.date)||a.index-b.index);
  const snapshots=dated.map(item=>item.snapshot);
  const trainSize = Math.max(1, Math.floor(number(options.trainSize) ?? 2));
  const testSize = Math.max(1, Math.floor(number(options.testSize) ?? 2));
  const step = Math.max(1, Math.floor(number(options.step) ?? testSize));
  const horizons = normalizePositiveIntegers(
    options.horizons, DEFAULT_HORIZONS, DEFAULT_HORIZONS);
  const topNs = normalizePositiveIntegers(
    options.topNs, DEFAULT_TOP_NS);
  const neutralEvery = Math.max(
    2, Math.floor(number(options.neutralEvery) ?? 2));
  const neutralExposure = Math.min(
    0.5, Math.max(0, number(options.neutralExposure) ?? 0.5));
  const costs = {
    commissionBps: number(options.costs?.commissionBps) ?? 3,
    stampTaxBps: number(options.costs?.stampTaxBps) ?? 5,
    slippageBps: number(options.costs?.slippageBps) ?? 5
  };
  const histories = input?.histories ?? input?.historyBySymbol ?? input?.prices ?? {};
  const legacy = makeStore(topNs, horizons);
  const baseline = makeStore(topNs, horizons);
  const busyUntil = new Map();
  const gated = makeStore(topNs, horizons);
  const decisions = [];
  const folds = [];
  const seenValidationDates = new Set();
  const diagnostics = {
    snapshotCount: snapshots.length, invalidSnapshotDates, duplicateSnapshotDates,
    foldCount: 0,
    duplicateValidationDates: 0,
    skippedPartialFolds: 0,
    trainingSnapshotCount: 0,
    validationSnapshotCount: 0,
    baselineTransactions: 0,
    gatedTransactions: 0
  };
  let neutralOrdinal = 0;
  const policies = new Map();
  for(const snapshot of snapshots){
    const policy=evaluateRegimeExecution(snapshot,{neutralEvery,neutralOrdinal,neutralExposure});
    policies.set(snapshotDate(snapshot),policy);
    if(policy.state==='neutral')neutralOrdinal++;
  }

  for (let start = trainSize; start < snapshots.length; start += step) {
    const training = snapshots.slice(Math.max(0, start - trainSize), start);
    let validation = snapshots.slice(start, start + testSize);
    if (validation.length < testSize && options.includePartial !== true) {
      if (validation.length) diagnostics.skippedPartialFolds += 1;
      continue;
    }
    validation = validation.filter(snapshot => {
      const date = snapshotDate(snapshot);
      if (seenValidationDates.has(date)) {
        diagnostics.duplicateValidationDates += 1;
        return false;
      }
      seenValidationDates.add(date);
      return true;
    });
    if (!validation.length) continue;
    diagnostics.trainingSnapshotCount += training.length;
    diagnostics.validationSnapshotCount += validation.length;
    const fold = {
      fold: folds.length + 1,
      training: foldDates(training),
      validation: foldDates(validation),
      regimes: { bull: 0, sideways: 0, bear: 0, unknown: 0 }
    };

    for (const snapshot of validation) {
      const date = normalizeExecutionAsOf(snapshot);
      const before = policies.get(date);
      const regime = before.regime;
      if (fold.regimes[regime] !== undefined) fold.regimes[regime] += 1;
      decisions.push({
        asOf: date, regime, state: before.state, action: before.action,
        exposure: before.exposure, frequencyEligible: before.frequencyEligible,
        neutralOrdinal: before.neutralOrdinal, neutralEvery,
        reason: before.reason, confidence: before.classification.confidence
      });

      for (const topN of topNs) {
        const replay = backtestAlpha({
          predictions: [snapshot], histories
        }, {
          topN, selectionScore: 'v12', horizons, costs
        });
        for (const horizon of horizons) {
          const horizonKey = 'T+' + horizon;
          const rawTrades = replay.results[horizonKey]?.trades ?? [];
          const legacyTrades = rawTrades.map(trade => ({
            ...trade, executionExposure: 1, executionAction: 'LEGACY',
            marketRegime: regime, plannedTopN: topN
          }));
          const eligibleTrades = rawTrades.filter(trade =>
            candidateTimingSignal(trade) === 'BUY_NOW');
          const scheduleKey = topN + ':' + horizon;
          const holding = date <= (busyUntil.get(scheduleKey) ?? '');
          const baselineTrades = holding ? [] : eligibleTrades.map(trade => ({
            ...trade, executionExposure: 1, executionAction: 'BUY_NOW',
            executionState: 'baseline', marketRegime: regime, plannedTopN: topN
          }));
          const gatedTrades = baselineTrades.filter(trade =>
            canExecuteBuyNow(before, trade)).map(trade => attachExecution(trade,before,topN));
          if(!holding){
            const exits=baselineTrades.filter(t=>t.status==='ok').map(t=>t.exitDate).sort();
            if(exits.length)busyUntil.set(scheduleKey,exits.at(-1));
          }
          const legacyPeriod=cohortPeriod(legacyTrades,date,regime,'LEGACY',1,topN,horizon);
          const baselinePeriod=cohortPeriod(baselineTrades,date,regime,holding?'HOLD':'BUY_NOW',1,topN,horizon);
          const gatedPeriod=cohortPeriod(gatedTrades,date,regime,holding?'HOLD':before.action,before.exposure,topN,horizon);
          addToStore(legacy,regime,topN,horizon,legacyTrades,legacyPeriod);
          addToStore(baseline,regime,topN,horizon,baselineTrades,baselinePeriod);
          addToStore(gated,regime,topN,horizon,gatedTrades,gatedPeriod);
          diagnostics.baselineTransactions+=baselineTrades.filter(t=>t.status==='ok').length;
          diagnostics.gatedTransactions+=gatedTrades.filter(t=>t.status==='ok').length;
        }
      }
    }
    folds.push(fold);
  }

  diagnostics.foldCount=folds.length;
  const aggregate = { legacy: {}, baseline: {}, gated: {} };
  for (const [name, store] of [['legacy', legacy], ['baseline', baseline], ['gated', gated]]) {
    aggregate[name] = {};
    for (const regime of ['overall', ...REGIMES]) {
      aggregate[name][regime] = {};
      for (const topN of topNs) {
        aggregate[name][regime]['top' + topN] = {};
        for (const horizon of horizons) {
          aggregate[name][regime]['top' + topN]['T+' + horizon] =
            resultFor(store[regime]['top' + topN]['T+' + horizon]);
        }
      }
    }
  }

  return {
    schema: V12_REGIME_GATE_SCHEMA,
    version: 'V12 Market Regime Execution Gate Validation',
    config: {
      trainSize, testSize, step, horizons, topNs, selectionScore: 'v12',
      costs, neutralEvery, neutralExposure,
      baseline: 'V12 TopN BUY_NOW slots, no market gate',
      legacy: 'all-signal V12 score replay, reference only',
      gated: 'BUY_NOW-only; neutral cadence and half exposure; bear/unknown WAIT',
      metricDefinition: 'exposure-weighted cohort replay; cash for skipped slots; not daily marked-to-market NAV',
      adjustment: 'none; fixed V12 scores; training metadata only'
    },
    folds, decisions, aggregate, diagnostics
  };
}

export const runV12RegimeGateBacktest = benchmarkV12RegimeGate;

async function main(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/v12_regime_backtest.js --input FILE');
  }
  const input = JSON.parse(await readFile(
    resolve(args[inputIndex + 1]), 'utf8'));
  const numeric=flag=>{const i=args.indexOf(flag);return i>=0?number(args[i+1]):undefined;};
  const options={trainSize:numeric('--train-size'),testSize:numeric('--test-size'),step:numeric('--step'),neutralEvery:numeric('--neutral-every'),neutralExposure:numeric('--neutral-exposure'),costs:{commissionBps:numeric('--commission-bps')??3,stampTaxBps:numeric('--stamp-bps')??5,slippageBps:numeric('--slippage-bps')??5}};
  console.log(JSON.stringify(benchmarkV12RegimeGate(input, options), null, 2));
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V12 regime gate: ' + error.message);
    process.exitCode = 1;
  });
}
