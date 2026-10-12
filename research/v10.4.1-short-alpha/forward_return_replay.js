import { finiteNumber, validDate, round, normalizeSessions, priceIndex } from './data_utils.js';

export const DEFAULT_HORIZONS = Object.freeze([1, 5, 20]);

function flattenPredictions(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return list.flatMap(item => Array.isArray(item?.predictions)
    ? item.predictions.map(stock => ({
        ...stock,
        date: stock?.date ?? item.date,
        decision: stock?.decision ?? item.decision
      }))
    : [item]);
}

function pending(horizon, targetDate, reason) {
  return { horizon, targetDate: targetDate ?? null, status: 'PENDING', reason };
}

function measure(horizon, targetDate, entryPrice, targetPrice, path, pathComplete, sideCost) {
  const gross = (targetPrice / entryPrice - 1) * 100;
  // Buy cost increases entry cash; sell cost reduces exit proceeds.
  const net = (targetPrice * (1 - sideCost) / (entryPrice * (1 + sideCost)) - 1) * 100;
  let maxDrawdown = null;
  let mfe = null;
  let mae = null;
  if (pathComplete) {
    let peak = entryPrice;
    maxDrawdown = 0;
    mfe = 0;
    mae = 0;
    for (const close of path) {
      peak = Math.max(peak, close);
      maxDrawdown = Math.max(maxDrawdown, (peak - close) / peak * 100);
      const change = (close / entryPrice - 1) * 100;
      mfe = Math.max(mfe, change);
      mae = Math.min(mae, change);
    }
  }
  return {
    horizon, targetDate, status: 'COMPLETED', entryPrice, targetPrice,
    grossReturnPct: round(gross), netReturnPct: round(net),
    costDragPct: round(gross - net), win: net > 0,
    pathComplete, pathReason: pathComplete ? null : 'intermediate-price-missing',
    maxDrawdownPct: maxDrawdown === null ? null : round(maxDrawdown),
    maxFavorableExcursionPct: mfe === null ? null : round(mfe),
    maxAdverseExcursionPct: mae === null ? null : round(mae)
  };
}

/**
 * Event-study returns from signal-session close, NOT an executable portfolio backtest.
 * Explicit sessions must include every exchange session; asOf limits observed data.
 */
export function replayForwardReturns(input = {}) {
  const calendar = normalizeSessions(input.sessions ?? input.observations?.sessions);
  const asOf = input.asOf === undefined ? calendar.at(-1) : validDate(input.asOf);
  if (!asOf) throw new TypeError('asOf must be a valid YYYY-MM-DD date');
  const horizons = input.horizons ?? DEFAULT_HORIZONS;
  if (!Array.isArray(horizons) || !horizons.length ||
      horizons.some(h => !Number.isInteger(h) || h < 1) ||
      new Set(horizons).size !== horizons.length) {
    throw new TypeError('horizons must contain unique positive integer session offsets');
  }
  const costBps = input.costBps === undefined ? 0 : finiteNumber(input.costBps);
  if (costBps === null || costBps < 0 || costBps >= 10000) {
    throw new TypeError('costBps must be in [0, 10000) per side');
  }
  const source = input.prices ?? input.observations?.prices ?? {};
  if (!source || Array.isArray(source) || typeof source !== 'object') {
    throw new TypeError('prices must be a symbol-to-price-history object');
  }
  const indices = new Map();
  const sessionIndex = new Map(calendar.map((date, i) => [date, i]));
  const diagnostics = {
    duplicatePredictions: 0, rejectedPredictions: 0,
    duplicatePriceDates: {}, pendingReasons: {}
  };
  for (const [symbol, raw] of Object.entries(source)) {
    const parsed = priceIndex(raw);
    indices.set(symbol, parsed.index);
    if (parsed.duplicateDates.length) diagnostics.duplicatePriceDates[symbol] = parsed.duplicateDates;
  }
  const seen = new Set();
  const outcomes = [];
  for (const prediction of flattenPredictions(input.predictions)) {
    const date = validDate(prediction?.date);
    const asOfDate = prediction?.asOfDate === undefined ? date : validDate(prediction.asOfDate);
    const symbol = String(prediction?.symbol ?? prediction?.stock ?? prediction?.code ?? '').trim();
    if (!date || !symbol || !asOfDate || asOfDate > date) {
      diagnostics.rejectedPredictions += 1;
      continue;
    }
    const key = date + '|' + symbol;
    if (seen.has(key)) {
      diagnostics.duplicatePredictions += 1;
      continue;
    }
    seen.add(key);
    const start = sessionIndex.get(date);
    const prices = indices.get(symbol) ?? new Map();
    const explicitEntry = prediction?.entryPrice === undefined
      ? null : finiteNumber(prediction.entryPrice);
    const entryPrice = prediction?.entryPrice === undefined
      ? prices.get(date) ?? null : explicitEntry;
    const entryReason = date > asOf ? 'signal-after-asof'
      : start === undefined ? 'signal-not-in-session-calendar'
      : entryPrice === null || entryPrice <= 0 ? 'entry-price-missing' : null;
    const results = {};
    for (const horizon of horizons) {
      const targetDate = start === undefined ? null : calendar[start + horizon] ?? null;
      let result;
      if (entryReason) result = pending(horizon, targetDate, entryReason);
      else if (!targetDate) result = pending(horizon, null, 'target-session-unavailable');
      else if (targetDate > asOf) result = pending(horizon, targetDate, 'target-after-asof');
      else if (!(prices.get(targetDate) > 0)) result = pending(horizon, targetDate, 'target-price-missing');
      else {
        const path = calendar.slice(start + 1, start + horizon + 1).map(day => prices.get(day));
        const complete = path.every(close => close > 0);
        result = measure(horizon, targetDate, entryPrice, prices.get(targetDate), path, complete, costBps / 10000);
      }
      if (result.status === 'PENDING') {
        diagnostics.pendingReasons[result.reason] = (diagnostics.pendingReasons[result.reason] ?? 0) + 1;
      }
      results['T+' + horizon] = result;
    }
    outcomes.push({
      predictionId: prediction.id ?? key, date, symbol,
      decision: prediction.decision ?? 'UNKNOWN',
      score: finiteNumber(prediction.score ?? prediction.adjustedScore),
      entryPrice: entryPrice > 0 ? entryPrice : null, horizons: results
    });
  }
  const statistics = {};
  for (const horizon of horizons) {
    const key = 'T+' + horizon;
    const results = outcomes.map(outcome => outcome.horizons[key]);
    const completed = results.filter(result => result.status === 'COMPLETED');
    const paths = completed.filter(result => result.pathComplete);
    statistics[key] = {
      evaluated: completed.length, pending: results.length - completed.length,
      wins: completed.filter(result => result.win).length,
      winRatePct: completed.length ? round(completed.filter(result => result.win).length / completed.length * 100) : null,
      averageReturnPct: completed.length ? round(completed.reduce((sum, result) => sum + result.netReturnPct, 0) / completed.length) : null,
      pathEvaluated: paths.length,
      maxDrawdownPct: paths.length ? Math.max(...paths.map(result => result.maxDrawdownPct)) : null
    };
  }
  return {
    schema: 'v10.4.1-short-alpha-forward-return-v1', asOf, costBps,
    returnBasis: 'signal-session-close-reference',
    drawdownBasis: 'worst-single-event-close-path',
    excursionBasis: 'close-path-not-intraday-high-low',
    sessions: calendar, outcomes, statistics, diagnostics
  };
}

export const replay = replayForwardReturns;
