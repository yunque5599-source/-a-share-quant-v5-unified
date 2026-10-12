import { normalizeMarketRisk } from '../v1040-core/adapter/market_adapter.js';
import { finiteNumber, validDate, round, clamp, normalizeSessions, priceIndex } from './data_utils.js';

export const EXIT_THRESHOLDS = Object.freeze({ exit: 70, trim: 45 });
export const EXIT_DEFAULTS = Object.freeze({
  ...EXIT_THRESHOLDS, stopLossPct: -5, trailingStopPct: 8, maxHoldingSessions: 20
});

function configuration(options) {
  const config = { ...EXIT_DEFAULTS, ...options };
  if (!(Number.isFinite(config.trim) && config.trim >= 0 &&
        Number.isFinite(config.exit) && config.exit > config.trim && config.exit <= 100 &&
        Number.isFinite(config.stopLossPct) && config.stopLossPct < 0 &&
        Number.isFinite(config.trailingStopPct) && config.trailingStopPct > 0 &&
        Number.isInteger(config.maxHoldingSessions) && config.maxHoldingSessions > 0)) {
    throw new TypeError('invalid exit configuration');
  }
  return config;
}

/**
 * Pure exit advice from an observed snapshot. Higher scores indicate stronger exit pressure.
 * daysHeld counts exchange sessions since purchase, NOT elapsed calendar days.
 */
export function calculateExitScore(position = {}, marketInput = 'unknown', options = {}) {
  position = position && typeof position === 'object' ? position : {};
  const config = configuration(options);
  const entryPrice = finiteNumber(position.entryPrice);
  const currentPrice = finiteNumber(position.currentPrice ?? position.price);
  const peakPrice = finiteNumber(position.peakPrice ?? position.highestPrice);
  const daysHeld = finiteNumber(position.daysHeld);
  const marketRisk = normalizeMarketRisk(position.marketRisk ?? marketInput);
  const missingFields = [];
  for (const [field, value] of Object.entries({ entryPrice, currentPrice, peakPrice })) {
    if (value === null || value <= 0) missingFields.push(field);
  }
  if (daysHeld === null || !Number.isInteger(daysHeld) || daysHeld < 0) missingFields.push('daysHeld');
  for (const field of ['trendBreak', 'flowWeakening', 'liquidityStress']) {
    if (typeof position[field] !== 'boolean') missingFields.push(field);
  }
  if (marketRisk === 'unknown') missingFields.push('marketRisk');
  const invalidReasons = [];
  if (peakPrice > 0 && ((currentPrice > 0 && peakPrice < currentPrice) || (entryPrice > 0 && peakPrice < entryPrice))) {
    invalidReasons.push('peak-below-entry-or-current-price');
  }
  const entryDate = validDate(position.entryDate);
  const asOfDate = validDate(position.asOfDate);
  if (position.entryDate !== undefined && !entryDate) invalidReasons.push('invalid-entry-date');
  if (position.asOfDate !== undefined && !asOfDate) invalidReasons.push('invalid-asof-date');
  if (entryDate && asOfDate && entryDate > asOfDate) invalidReasons.push('entry-after-asof');
  if (entryDate && asOfDate && entryDate === asOfDate && daysHeld > 0) {
    invalidReasons.push('holding-sessions-disagree-with-entry-date');
  }
  if (position.snapshotDate !== undefined) {
    const snapshotDate = validDate(position.snapshotDate);
    if (!snapshotDate || !asOfDate || snapshotDate > asOfDate) {
      invalidReasons.push('snapshot-after-asof-or-invalid');
    }
  }
  const pnlPct = entryPrice > 0 && currentPrice > 0 ? round((currentPrice / entryPrice - 1) * 100) : null;
  const drawdownPct = peakPrice > 0 && currentPrice > 0 ? round(Math.max(0, (peakPrice - currentPrice) / peakPrice * 100)) : null;
  const components = {
    drawdown: drawdownPct === null ? 0 : drawdownPct >= 8 ? 35 : drawdownPct >= 4 ? 20 : drawdownPct > 0 ? 8 : 0,
    trendBreak: position.trendBreak === true ? 25 : 0,
    market: marketRisk === 'weak' ? 25 : marketRisk === 'elevated' ? 12 : 0,
    flowWeakening: position.flowWeakening === true ? 15 : 0,
    profitProtection: pnlPct >= 20 ? 15 : pnlPct >= 10 ? 8 : 0,
    timeStop: daysHeld >= config.maxHoldingSessions ? 10 : daysHeld >= 10 ? 5 : 0,
    liquidityStress: position.liquidityStress === true ? 10 : 0
  };
  const exitScore = round(clamp(Object.values(components).reduce((sum, value) => sum + value, 0)));
  const hardReasons = [];
  if (pnlPct !== null && pnlPct <= config.stopLossPct) hardReasons.push('stop-loss');
  if (drawdownPct !== null && drawdownPct >= config.trailingStopPct) hardReasons.push('trailing-stop');
  if (daysHeld !== null && daysHeld >= config.maxHoldingSessions) hardReasons.push('holding-period-limit');
  const dataComplete = missingFields.length === 0 && invalidReasons.length === 0;
  const recommendation = dataComplete
    ? hardReasons.length || exitScore >= config.exit ? 'EXIT'
      : exitScore >= config.trim ? 'TRIM' : 'HOLD'
    : 'WAIT';
  const canSell = dataComplete && daysHeld >= 1;
  const action = (recommendation === 'EXIT' || recommendation === 'TRIM') && !canSell
    ? 'WAIT' : recommendation;
  const reasons = [...invalidReasons, ...hardReasons];
  for (const [factor, points] of Object.entries(components)) {
    if (points > 0) reasons.push(factor + ':' + points);
  }
  if (missingFields.length) reasons.push('missing-data');
  if (dataComplete && !canSell) reasons.push('a-share-t1-locked');
  return {
    schema: 'v10.4.1-short-alpha-exit-score-v1',
    exitScore, action, recommendation, canSell, dataComplete, missingFields,
    marketRisk, pnlPct: pnlPct === null ? null : round(pnlPct),
    drawdownPct: drawdownPct === null ? null : round(drawdownPct),
    daysHeld, components, reasons, thresholds: config
  };
}

/**
 * Derive price-based exit inputs only from bars at or before asOfDate.
 * Evidence flags must be supplied for that snapshot; future bars cannot alter the score.
 */
export function evaluateExitAtDate({ position = {}, bars = [], sessions = [], asOfDate, market = 'unknown' } = {}, options = {}) {
  const calendar = normalizeSessions(sessions);
  const cutoff = validDate(asOfDate);
  const entryDate = validDate(position.entryDate);
  const entryIndex = calendar.indexOf(entryDate);
  const currentIndex = calendar.indexOf(cutoff);
  const prices = priceIndex(bars).index;
  const pathDates = entryIndex >= 0 && currentIndex >= entryIndex
    ? calendar.slice(entryIndex, currentIndex + 1) : [];
  const completePath = pathDates.length > 0 && pathDates.every(day => prices.get(day) > 0);
  const entryPrice = position.entryPrice ?? prices.get(entryDate);
  const snapshot = {
    ...position, entryPrice, entryDate: position.entryDate, asOfDate,
    daysHeld: currentIndex >= entryIndex && entryIndex >= 0 ? currentIndex - entryIndex : null,
    currentPrice: prices.get(cutoff) ?? null,
    peakPrice: completePath
      ? Math.max(finiteNumber(entryPrice) ?? 0, ...pathDates.map(day => prices.get(day)))
      : null
  };
  return calculateExitScore(snapshot, market, options);
}

export const exitScore = calculateExitScore;
