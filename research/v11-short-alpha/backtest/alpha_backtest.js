import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finiteNumber, round, validDate, asOfDate } from '../schema.js';
import { computeV12TradeScore } from '../v12_trade_score.js';

export const BACKTEST_SCHEMA = 'v11-short-alpha-backtest-v1';
export const DEFAULT_HORIZONS = Object.freeze([1, 3, 5]);
const allowedHorizons = new Set(DEFAULT_HORIZONS);

const list = value => Array.isArray(value) ? value : [];
const number = value => finiteNumber(value);
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);
const symbolOf = candidate => String(
  candidate?.symbol ?? candidate?.code ?? candidate?.f12 ?? ''
).trim();

function inputSnapshots(input) {
  if (Array.isArray(input?.predictions)) return input.predictions;
  if (Array.isArray(input?.snapshots)) return input.snapshots;
  const snapshot = input?.prediction ?? input?.alphaResult ?? input?.result ?? input;
  return snapshot && typeof snapshot === 'object' ? [snapshot] : [];
}

function rankingOf(snapshot) {
  return list(snapshot?.ranking ?? snapshot?.candidates ?? snapshot?.stocks ??
    snapshot?.decision?.datasetCandidates ?? snapshot?.decision?.ranking ??
    snapshot?.decision?.tradeRanking);
}

function historyMapOf(input, snapshot) {
  return input?.histories ?? input?.historyBySymbol ?? input?.prices ??
    snapshot?.histories ?? snapshot?.historyBySymbol ?? snapshot?.prices ?? {};
}

function historyFor(historyMap, symbol) {
  if (historyMap instanceof Map) return historyMap.get(symbol);
  return historyMap?.[symbol] ?? historyMap?.[String(symbol)];
}

function rowsOf(raw) {
  if (Array.isArray(raw)) return raw;
  return list(raw?.data?.klines ?? raw?.klines ?? raw?.rows ?? raw?.bars ?? raw?.prices);
}

function parseHistory(raw, diagnostics) {
  const bars = [];
  const seen = new Set();
  let invalid = false;
  for (const row of rowsOf(raw)) {
    const fields = typeof row === 'string' ? row.split(',') : row;
    const array = Array.isArray(fields);
    const date = validDate(array ? fields[0] : fields?.date);
    if (!date) {
      diagnostics.invalidDates += 1;
      invalid = true;
      continue;
    }
    if (seen.has(date)) {
      diagnostics.duplicateDates += 1;
      invalid = true;
      continue;
    }
    seen.add(date);
    const close = number(array ? fields[2] : fields?.close ?? fields?.price);
    if (!(close > 0)) {
      diagnostics.invalidCloses += 1;
      invalid = true;
      continue;
    }
    bars.push({ date, close });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { bars, invalid };
}

function requestedHorizons(value) {
  const requested = Array.isArray(value) ? value : DEFAULT_HORIZONS;
  const normalized = [...new Set(requested.map(number)
    .filter(horizon => Number.isInteger(horizon) && allowedHorizons.has(horizon)))];
  return normalized.length ? normalized.sort((a, b) => a - b) : [...DEFAULT_HORIZONS];
}

function asOfFor(snapshot, fallback) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt ?? fallback);
}

function alphaScore(candidate) {
  return number(candidate?.scores?.alpha ?? candidate?.alphaScore ?? candidate?.score);
}

function timingScore(candidate) {
  return number(candidate?.scores?.timingRaw ?? candidate?.scores?.timing);
}

function compositeScore(candidate) {
  return number(candidate?.scores?.compositeRaw ?? candidate?.scores?.composite);
}
function v12TradeScore(candidate) {
  return computeV12TradeScore(candidate)?.scoreRaw ?? null;
}
function earlyOpportunityScore(candidate) {
  return number(candidate?.features?.earlyOpportunity?.score ??
    candidate?.scores?.earlyOpportunityRaw ?? candidate?.scores?.earlyOpportunity ??
    candidate?.earlyOpportunity?.score);
}
function timingSignal(candidate) {
  const explicit = candidate?.timing?.signal ?? candidate?.timingSignal;
  if (typeof explicit === 'string') return explicit;
  const score = timingScore(candidate);
  if (score === null) return 'UNKNOWN';
  return score >= 75 ? 'BUY_NOW' : score >= 50 ? 'WAIT_PULLBACK' : 'AVOID';
}

function selectionValue(candidate, selectionScore) {
  if (selectionScore === 'composite') return compositeScore(candidate);
  if (selectionScore === 'timing') return timingScore(candidate);
  if (selectionScore === 'random') return null;
  if (selectionScore === 'v12' || selectionScore === 'v12Trade') return v12TradeScore(candidate);
  if (selectionScore === 'earlyOpportunity') return earlyOpportunityScore(candidate);
  return alphaScore(candidate);
}

function orderedRanking(ranking, selectionScore) {
  if (selectionScore === 'alpha') return ranking;
  const values = ranking.map((candidate, index) => ({
    candidate, index, value: selectionValue(candidate, selectionScore)
  }));
  values.sort((left, right) => {
    if (left.value === null && right.value === null) return left.index - right.index;
    if (left.value === null) return 1;
    if (right.value === null) return -1;
    return right.value - left.value ||
      (alphaScore(right.candidate) ?? -Infinity) - (alphaScore(left.candidate) ?? -Infinity) ||
      left.index - right.index;
  });
  return values.map(item => item.candidate);
}

function normalizeCosts(options = {}) {
  const costs = options.costs ?? {};
  const bps = value => Math.max(0, number(value) ?? 0);
  return {
    commissionBps: bps(costs.commissionBps ?? options.commissionBps),
    stampTaxBps: bps(costs.stampTaxBps ?? options.stampTaxBps),
    slippageBps: bps(costs.slippageBps ?? options.slippageBps),
    legacyRoundTripCostBps: bps(options.roundTripCostBps)
  };
}

function tradeReturn(entryPrice, exitPrice, costs) {
  const slip = costs.slippageBps / 10000;
  const commission = costs.commissionBps / 10000;
  const stamp = costs.stampTaxBps / 10000;
  const entryExecution = entryPrice * (1 + slip);
  const exitExecution = exitPrice * (1 - slip);
  const grossFactor = exitPrice / entryPrice;
  const buyCommission = entryExecution * commission;
  const sellCommission = exitExecution * commission;
  const stampTax = exitExecution * stamp;
  const slippageCost = (entryExecution - entryPrice) + (exitPrice - exitExecution);
  const invested = entryExecution + buyCommission;
  const proceeds = exitExecution - sellCommission - stampTax;
  const legacyFactor = Math.max(0, 1 - costs.legacyRoundTripCostBps / 10000);
  const netFactor = proceeds / invested * legacyFactor;
  const grossReturnPct = (grossFactor - 1) * 100;
  const returnPct = (netFactor - 1) * 100;
  return {
    grossReturnPct,
    returnPct,
    costPct: (grossFactor - netFactor) * 100,
    commissionPct: (buyCommission + sellCommission) / entryPrice * 100,
    stampTaxPct: stampTax / entryPrice * 100,
    slippagePct: slippageCost / entryPrice * 100,
    totalCostPct: (grossFactor - netFactor) * 100
  };
}

function maxDrawdown(trades) {
  if (!trades.length) return null;
  const grouped = new Map();
  for (const trade of trades) {
    const group = grouped.get(trade.entryDate) ?? [];
    group.push(trade.returnPct);
    grouped.set(trade.entryDate, group);
  }
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const date of [...grouped.keys()].sort()) {
    const periodReturn = mean(grouped.get(date));
    equity *= 1 + periodReturn / 100;
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

function resultFor(horizon, trades) {
  const valid = trades.filter(trade => trade.status === 'ok');
  const returns = valid.map(trade => trade.returnPct);
  const wins = returns.filter(value => value > 0);
  const buyNow = valid.filter(trade => trade.timingSignal === 'BUY_NOW');
  const buyNowCorrect = buyNow.filter(trade => trade.returnPct > 0).length;
  return {
    horizon,
    observations: valid.length,
    sampleCount: valid.length,
    tradeCount: valid.length,
    unavailable: trades.length - valid.length,
    averageReturnPct: metric(mean(returns)),
    winRatePct: valid.length ? metric(wins.length / valid.length * 100) : null,
    maxDrawdownPct: metric(maxDrawdown(valid)),
    payoffRatio: metric(payoffRatio(returns)),
    buyNowSamples: buyNow.length,
    buyNowCorrect,
    buyNowCoveragePct: valid.length ? metric(buyNow.length / valid.length * 100) : null,
    buyNowAccuracyPct: buyNow.length ? metric(buyNowCorrect / buyNow.length * 100) : null,
    trades
  };
}

/**
 * Replay one or more captured V11 Alpha rankings against future closes.
 *
 * T+h means the h-th valid historical bar strictly after each snapshot asOf
 * date. Future bars are never filled, shifted, or counted as zero. Incomplete
 * Alpha records are excluded unless includeIncomplete=true.
 */
export function backtestAlpha(input = {}, options = {}) {
  const snapshots = inputSnapshots(input);
  const horizons = requestedHorizons(options.horizons);
  const includeIncomplete = options.includeIncomplete === true;
  const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : null;
  const selectionScore = options.selectionScore ?? 'alpha';
  if (!['alpha', 'timing', 'composite', 'random', 'v12', 'v12Trade', 'earlyOpportunity'].includes(selectionScore)) {
    throw new Error('Unknown selectionScore: ' + selectionScore);
  }
  const costs = normalizeCosts(options);
  const diagnostics = {
    snapshotCount: snapshots.length,
    candidateCount: 0,
    eligibleCandidates: 0,
    skippedIncomplete: 0,
    invalidSymbols: 0,
    noSnapshotDate: 0,
    missingHistory: 0,
    unavailableByHorizon: Object.fromEntries(horizons.map(horizon => ['T+' + horizon, 0])),
    invalidDates: 0,
    duplicateDates: 0,
    invalidCloses: 0
  };
  const tradesByHorizon = Object.fromEntries(horizons.map(horizon => ['T+' + horizon, []]));
  const historyCache = new Map();
  const snapshotDates = [];

  for (const snapshot of snapshots) {
    const snapshotDate = asOfFor(snapshot, input?.asOf);
    if (snapshotDate) snapshotDates.push(snapshotDate);
    const histories = historyMapOf(input, snapshot);
    const ranking = orderedRanking(rankingOf(snapshot), selectionScore);
    const selected = topN ? ranking.slice(0, topN) : ranking;
    diagnostics.candidateCount += selected.length;

    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index] ?? {};
      const symbol = symbolOf(candidate);
      const rank = index + 1;
      const alphaRank = number(candidate.rank);
      const score = alphaScore(candidate);
      const timing = timingScore(candidate);
      const psychology = number(candidate?.scores?.psychologyRaw ?? candidate?.scores?.psychology ?? candidate?.psychology?.score);
      const composite = compositeScore(candidate);
      const v12Trade = v12TradeScore(candidate);
      const selectedValue = selectionValue(candidate, selectionScore);
      const signal = timingSignal(candidate);
      const qualityBlocked = candidate?.quality?.complete === false;
      let skipReason = null;
      if (!/^\d{6}$/.test(symbol)) {
        diagnostics.invalidSymbols += 1;
        skipReason = 'invalid-symbol';
      } else if (!snapshotDate) {
        diagnostics.noSnapshotDate += 1;
        skipReason = 'snapshot-asof-missing-or-invalid';
      } else if (qualityBlocked && !includeIncomplete) {
        diagnostics.skippedIncomplete += 1;
        skipReason = 'incomplete-alpha-record';
      } else if (!['alpha', 'random'].includes(selectionScore) && selectedValue === null) {
        skipReason = 'missing-' + selectionScore + '-score';
      } else {
        diagnostics.eligibleCandidates += 1;
      }

      let parsed = null;
      if (!skipReason) {
        if (!historyCache.has(symbol)) {
          const rawHistory = historyFor(histories, symbol);
          if (rawHistory === undefined || rawHistory === null) {
            diagnostics.missingHistory += 1;
            historyCache.set(symbol, { bars: [], invalid: false, missing: true });
          } else {
            historyCache.set(symbol, parseHistory(rawHistory, diagnostics));
          }
        }
        parsed = historyCache.get(symbol);
        if (parsed?.missing) skipReason = 'missing-history';
        else if (parsed?.invalid) skipReason = 'invalid-history';
      }

      let entryDate = snapshotDate;
      let entryPrice = number(candidate.price);
      let entryBasis = 'candidate.price';
      if (!skipReason) {
        const baseline = parsed.bars.filter(bar => bar.date <= snapshotDate).at(-1);
        if (!(entryPrice > 0) && baseline) {
          entryPrice = baseline.close;
          entryBasis = 'history-close';
        }
        if (!(entryPrice > 0)) skipReason = 'entry-price-missing';
      }

      for (const horizon of horizons) {
        const key = 'T+' + horizon;
        const future = parsed?.bars?.filter(bar => bar.date > snapshotDate) ?? [];
        let trade;
        if (skipReason) {
          trade = {
            symbol, rank, alphaRank, alphaScore: score, timingScore: timing,
            psychologyScore: psychology, compositeScore: composite,
            v12TradeScore: v12Trade, earlyOpportunityScore:earlyOpportunityScore(candidate),
            timingSignal: signal, selectedBy: selectionScore,
            selectionValue: selectedValue, entryDate,
            entryPrice: entryPrice > 0 ? entryPrice : null,
            horizon, status: 'unavailable', reason: skipReason
          };
        } else if (future.length < horizon) {
          trade = {
            symbol, rank, alphaRank, alphaScore: score, timingScore: timing,
            psychologyScore: psychology, compositeScore: composite,
            v12TradeScore: v12Trade, earlyOpportunityScore:earlyOpportunityScore(candidate),
            timingSignal: signal, selectedBy: selectionScore,
            selectionValue: selectedValue, entryDate, entryPrice, horizon,
            status: 'unavailable', reason: 'no-forward-bar'
          };
        } else {
          const exit = future[horizon - 1];
          const returns = tradeReturn(entryPrice, exit.close, costs);
          trade = {
            symbol, rank, alphaRank, alphaScore: score, timingScore: timing,
            psychologyScore: psychology, compositeScore: composite,
            v12TradeScore: v12Trade, earlyOpportunityScore:earlyOpportunityScore(candidate),
            timingSignal: signal, selectedBy: selectionScore,
            selectionValue: selectedValue, entryDate, entryPrice, entryBasis,
            horizon, exitDate: exit.date, exitPrice: exit.close,
            grossReturnPct: round(returns.grossReturnPct),
            netReturnPct: round(returns.returnPct),
            returnPct: round(returns.returnPct),
            commissionPct: round(returns.commissionPct),
            stampTaxPct: round(returns.stampTaxPct),
            slippagePct: round(returns.slippagePct),
            totalCostPct: round(returns.totalCostPct),
            costPct: round(returns.costPct), status: 'ok'
          };
        }
        if (trade.status !== 'ok') diagnostics.unavailableByHorizon[key] += 1;
        tradesByHorizon[key].push(trade);
      }
    }
  }

  const results = Object.fromEntries(horizons.map(horizon => {
    const key = 'T+' + horizon;
    return [key, resultFor(horizon, tradesByHorizon[key])];
  }));
  const uniqueDates = [...new Set(snapshotDates)].sort();
  return {
    schema: BACKTEST_SCHEMA,
    version: 'V11 Short Alpha Historical Validation',
    asOf: uniqueDates.length === 1 ? uniqueDates[0] : null,
    snapshots: snapshots.length,
    horizons,
    options: { includeIncomplete, topN, selectionScore, costs },
    diagnostics,
    results
  };
}

export const runAlphaBacktest = backtestAlpha;
export const validateAlphaHistory = backtestAlpha;

async function main(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) {
    throw new Error('Usage: node research/v11-short-alpha/backtest/alpha_backtest.js --input FILE');
  }
  const input = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
  const selectionIndex = args.indexOf('--selection-score');
  const selectionScore = selectionIndex >= 0 ? args[selectionIndex + 1] : 'alpha';
  const options = {
    includeIncomplete: args.includes('--include-incomplete'),
    costs: {commissionBps: number(args[args.indexOf('--commission-bps') + 1]),
      stampTaxBps: number(args[args.indexOf('--stamp-bps') + 1]),
      slippageBps: number(args[args.indexOf('--slippage-bps') + 1])},
    selectionScore
  };
  console.log(JSON.stringify(backtestAlpha(input, options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('V11 Alpha backtest: ' + error.message);
    process.exitCode = 1;
  });
}
