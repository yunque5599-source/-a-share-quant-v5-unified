import { asOfDate, clamp, finiteNumber, round } from './schema.js';

export const EARLY_OPPORTUNITY_VERSION = 'V12 Early Opportunity Discovery v1';

const n = finiteNumber;
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);
const list = value => Array.isArray(value) ? value : [];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (from, to) => from !== null && to !== null && from > 0 ? (to / from - 1) * 100 : null;

function normalizeBar(raw) {
  const fields = typeof raw === 'string' ? raw.split(',') : raw;
  const array = Array.isArray(fields);
  const date = String(array ? fields?.[0] ?? '' : raw?.date ?? raw?.time ?? '');
  const close = n(array ? fields?.[2] : raw?.close ?? raw?.price);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(close > 0)) return null;
  return {
    date, close,
    high:n(array ? fields?.[3] : raw?.high) ?? close,
    low:n(array ? fields?.[4] : raw?.low) ?? close,
    volume:n(array ? fields?.[5] : raw?.volume ?? raw?.vol),
    amount:n(array ? fields?.[6] : raw?.amount ?? raw?.turnover)
  };
}

function eligibleBars(rawBars, asOf, barComplete = false) {
  const cutoff = asOfDate(asOf);
  const dateOnly = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const seen = new Set();
  let futureBarsIgnored = 0, sameDayBarsIgnored = 0;
  const bars = [];
  for (const raw of list(rawBars)) {
    const row = normalizeBar(raw);
    if (!row || seen.has(row.date)) continue;
    seen.add(row.date);
    if (!cutoff) continue;
    if (row.date > cutoff) { futureBarsIgnored += 1; continue; }
    if (!dateOnly && row.date === cutoff && barComplete !== true) {
      sameDayBarsIgnored += 1; continue;
    }
    bars.push(row);
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { bars, cutoff, futureBarsIgnored, sameDayBarsIgnored };
}

function proximityScore(distancePct) {
  if (distancePct === null) return null;
  if (distancePct <= 3) return 92;
  if (distancePct <= 6) return 84;
  if (distancePct <= 10) return 72;
  if (distancePct <= 15) return 56;
  if (distancePct <= 22) return 38;
  return 18;
}

function baseScore(rangePct, volatilityRatio) {
  const range = rangePct === null ? null : rangePct <= 6 ? 90 : rangePct <= 10 ? 78 :
    rangePct <= 15 ? 62 : rangePct <= 22 ? 42 : 22;
  const compression = volatilityRatio === null ? null : volatilityRatio <= 0.65 ? 90 :
    volatilityRatio <= 0.85 ? 78 : volatilityRatio <= 1.05 ? 60 :
      volatilityRatio <= 1.3 ? 42 : 24;
  const available = [range, compression].filter(value => value !== null);
  return available.length ? mean(available) : null;
}

function turnScore({ r3, r5, r10, ma5Slope, close, ma5, upDayRatio }) {
  const pieces = [];
  if (r3 !== null) pieces.push(r3 >= 0.5 && r3 <= 5 ? 90 :
    r3 > 5 && r3 <= 8 ? 72 : r3 > 8 ? 42 : r3 >= -2 ? 52 : 20);
  if (r5 !== null) pieces.push(r5 >= 0 && r5 <= 8 ? 85 :
    r5 > 8 && r5 <= 12 ? 62 : r5 > 12 ? 30 : r5 >= -5 ? 48 : 18);
  if (r10 !== null) pieces.push(r10 >= -4 && r10 <= 12 ? 72 : r10 < -12 ? 24 : 52);
  if (ma5Slope !== null) pieces.push(ma5Slope > 0.25 ? 88 : ma5Slope > 0 ? 72 :
    ma5Slope > -0.25 ? 48 : 22);
  if (close !== null && ma5 !== null) pieces.push(close >= ma5 ? 78 : close >= ma5 * 0.97 ? 52 : 24);
  if (upDayRatio !== null) pieces.push(upDayRatio >= 0.6 ? 78 : upDayRatio >= 0.4 ? 54 : 28);
  return pieces.length ? mean(pieces) : null;
}

function accumulationScore(bars, capitalScore) {
  const recent = bars.slice(-10);
  const pairs = recent.slice(1).map((bar, index) => ({
    change: pct(recent[index].close, bar.close), volume:bar.volume
  })).filter(row => row.change !== null && row.volume !== null && row.volume > 0);
  const up = pairs.filter(row => row.change > 0).map(row => row.volume);
  const down = pairs.filter(row => row.change < 0).map(row => row.volume);
  const upDownRatio = up.length && down.length ? mean(up) / mean(down) : null;
  const volumeScore = upDownRatio === null ? null : upDownRatio >= 1.35 ? 88 :
    upDownRatio >= 1.1 ? 76 : upDownRatio >= 0.9 ? 58 : upDownRatio >= 0.7 ? 38 : 20;
  const available = [volumeScore, n(capitalScore)].filter(value => value !== null);
  return { score:available.length ? mean(available) : null, upDownVolumeRatio:metric(upDownRatio) };
}

function safetyScore({ r3, r5, distanceMa5, distanceMa20, trend20, lowBreak }) {
  const penalties = [];
  if (r3 !== null) penalties.push(Math.max(0, r3 - 6) * 5);
  if (r5 !== null) penalties.push(Math.max(0, r5 - 10) * 3);
  if (distanceMa5 !== null) penalties.push(Math.max(0, distanceMa5 - 5) * 2.5);
  if (distanceMa20 !== null) penalties.push(Math.max(0, distanceMa20 - 10) * 1.2);
  let score = clamp(100 - (mean(penalties) ?? 0));
  if (trend20 !== null && trend20 < -18) score = Math.min(score, 35);
  if (lowBreak) score = Math.min(score, 20);
  return score;
}

/**
 * Finds early, non-extended setups rather than simply cheap-priced or oversold stocks.
 * All price/volume calculations use bars available at the snapshot timestamp only.
 * The score is a research ranking, not a calibrated probability of profit.
 */
export function computeEarlyOpportunity(input = {}) {
  const filtered = eligibleBars(input.bars ?? input.history, input.asOf ?? input.snapshot?.asOf,
    input.barComplete === true);
  const bars = filtered.bars;
  const empty = {
    version:EARLY_OPPORTUNITY_VERSION, score:null, stage:'insufficient-data', confidence:0,
    components:{location:null, baseQuality:null, earlyTurn:null, accumulation:null,
      capitalFlow:null, sector:null, extensionSafety:null, psychology:null},
    metrics:{distance20dLowPct:null, distance60dLowPct:null, position20dRangePct:null,
      range10dPct:null, volatilityCompressionRatio:null, return3dPct:null, return5dPct:null,
      return10dPct:null, return20dPct:null, distanceMa5Pct:null, distanceMa20Pct:null,
      upDownVolumeRatio:null},
    reasons:['insufficient-history'],
    diagnostics:{asOfDate:filtered.cutoff, barsUsed:bars.length,
      futureBarsIgnored:filtered.futureBarsIgnored, sameDayBarsIgnored:filtered.sameDayBarsIgnored}
  };
  if (!filtered.cutoff || bars.length < 20) return empty;

  const close = bars.at(-1).close;
  const recent20 = bars.slice(-20);
  const recent60 = bars.slice(-60);
  const min20 = Math.min(...recent20.map(row => row.low));
  const max20 = Math.max(...recent20.map(row => row.high));
  const min60 = recent60.length >= 40 ? Math.min(...recent60.map(row => row.low)) : null;
  const max60 = recent60.length >= 40 ? Math.max(...recent60.map(row => row.high)) : null;
  const distance20dLow = pct(min20, close);
  const distance60dLow = min60 === null ? null : pct(min60, close);
  const position20d = max20 > min20 ? (close - min20) / (max20 - min20) * 100 : null;
  const ma = period => bars.length >= period ? mean(bars.slice(-period).map(row => row.close)) : null;
  const ma5 = ma(5), ma20 = ma(20);
  const ma5Prior = bars.length >= 8 ? mean(bars.slice(-8, -3).map(row => row.close)) : null;
  const ma5Slope = ma5 !== null && ma5Prior !== null ? pct(ma5Prior, ma5) / 3 : null;
  const r3 = bars.length >= 4 ? pct(bars.at(-4).close, close) : null;
  const r5 = pct(bars.at(-6).close, close);
  const r10 = pct(bars.at(-11).close, close);
  const r20 = pct(bars.at(-21).close, close);
  const range10 = bars.slice(-10);
  const rangePct = close > 0 ? (Math.max(...range10.map(row => row.high)) /
    Math.min(...range10.map(row => row.low)) - 1) * 100 : null;
  const dailyReturns = bars.slice(-20).slice(1).map((row, index) =>
    pct(bars.slice(-20)[index].close, row.close)).filter(value => value !== null);
  const recentVol = dailyReturns.slice(-5);
  const priorVol = dailyReturns.slice(0, -5);
  const sd = values => {
    if (values.length < 2) return null;
    const avg = mean(values);
    return Math.sqrt(mean(values.map(value => (value - avg) ** 2)));
  };
  const volRecent = sd(recentVol), volPrior = sd(priorVol);
  const volatilityCompressionRatio = volRecent !== null && volPrior > 0 ? volRecent / volPrior : null;
  const upDayRatio = dailyReturns.length ? dailyReturns.filter(value => value > 0).length / dailyReturns.length : null;
  const recentLows = bars.slice(-5).map(row => row.low);
  const priorLows = bars.slice(-10, -5).map(row => row.low);
  const lowBreak = priorLows.length === 5 && Math.min(...recentLows) < Math.min(...priorLows) * 0.985 &&
    (r3 ?? 0) < 0 && (r5 ?? 0) < 0;
  const distanceMa5 = pct(ma5, close);
  const distanceMa20 = pct(ma20, close);

  const location20 = proximityScore(distance20dLow);
  const location60 = proximityScore(distance60dLow);
  const location = location60 === null ? location20 : location20 * 0.65 + location60 * 0.35;
  const base = baseScore(rangePct, volatilityCompressionRatio);
  const turn = turnScore({r3, r5, r10, ma5Slope, close, ma5, upDayRatio});
  const accumulation = accumulationScore(bars, input.features?.capital?.score);
  const extension = safetyScore({r3, r5, distanceMa5, distanceMa20, trend20:r20, lowBreak});
  const sector = n(input.features?.sector?.score);
  const psychology = n(input.psychology?.scoreRaw ?? input.psychology?.score);
  const components = {
    location:metric(location), baseQuality:metric(base), earlyTurn:metric(turn),
    accumulation:metric(accumulation.score), capitalFlow:metric(n(input.features?.capital?.score)),
    sector:metric(sector), extensionSafety:metric(extension), psychology:metric(psychology)
  };
  const weights = {location:0.22, baseQuality:0.18, earlyTurn:0.20, accumulation:0.15,
    capitalFlow:0.08, sector:0.05, extensionSafety:0.08, psychology:0.04};
  const available = Object.entries(weights).filter(([key]) => components[key] !== null);
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  let score = totalWeight > 0
    ? clamp(available.reduce((sum, [key, weight]) => sum + components[key] * weight, 0) / totalWeight)
    : null;
  const reasons = [];
  if (distance20dLow !== null && distance20dLow <= 10) reasons.push('near-20d-low-zone');
  if (distance60dLow !== null && distance60dLow <= 15) reasons.push('near-60d-low-zone');
  if (rangePct !== null && rangePct <= 12) reasons.push('base-range-compressed');
  if ((r3 ?? -Infinity) > 0 && (ma5Slope ?? -Infinity) > 0) reasons.push('short-term-turn-up');
  if (accumulation.score !== null && accumulation.score >= 65) reasons.push('up-day-volume-or-flow-support');
  if (extension < 45) reasons.push('extension-or-downtrend-risk');
  if (lowBreak) reasons.push('recent-low-breakdown-risk');
  if (r20 !== null && r20 < -18) reasons.push('persistent-downtrend-risk');

  let stage = 'watch';
  if (lowBreak || (r20 !== null && r20 < -25 && (r3 ?? 0) <= 0)) stage = 'downtrend-risk';
  else if (extension < 35 || (r5 !== null && r5 > 15)) stage = 'extended';
  else if (location >= 65 && base !== null && base >= 55 && (turn ?? 0) >= 52) stage = 'early-base';
  else if ((r3 ?? -Infinity) > 0 && (ma5Slope ?? -Infinity) > 0 && (turn ?? 0) >= 58) stage = 'turning-up';

  const dataCompleteness = [location, base, turn, accumulation.score, extension]
    .filter(value => value !== null).length / 5;
  const historyConfidence = Math.min(1, bars.length / 40);
  const confidence = Math.round(dataCompleteness * historyConfidence * 100) / 100;
  if (score !== null && stage === 'downtrend-risk') score = Math.min(score, 44);
  if (score !== null && stage === 'extended') score = Math.min(score, 58);
  return {
    version:EARLY_OPPORTUNITY_VERSION,
    score:metric(score),
    stage,
    confidence,
    components,
    metrics:{
      distance20dLowPct:metric(distance20dLow), distance60dLowPct:metric(distance60dLow),
      position20dRangePct:metric(position20d), range10dPct:metric(rangePct),
      volatilityCompressionRatio:metric(volatilityCompressionRatio),
      return3dPct:metric(r3), return5dPct:metric(r5), return10dPct:metric(r10),
      return20dPct:metric(r20), distanceMa5Pct:metric(distanceMa5),
      distanceMa20Pct:metric(distanceMa20), upDownVolumeRatio:accumulation.upDownVolumeRatio
    },
    reasons,
    diagnostics:{asOfDate:filtered.cutoff, barsUsed:bars.length,
      futureBarsIgnored:filtered.futureBarsIgnored, sameDayBarsIgnored:filtered.sameDayBarsIgnored}
  };
}

export function withEarlyOpportunityPsychology(candidate = {}) {
  const current = candidate.features?.earlyOpportunity;
  if (!current || current.score === null) return candidate;
  const psychology = n(candidate.psychology?.scoreRaw ?? candidate.psychology?.score);
  const components = {...current.components, psychology:metric(psychology)};
  const weights = {location:0.22, baseQuality:0.18, earlyTurn:0.20, accumulation:0.15,
    capitalFlow:0.08, sector:0.05, extensionSafety:0.08, psychology:0.04};
  const available = Object.entries(weights).filter(([key]) => components[key] !== null);
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  let score = totalWeight > 0
    ? clamp(available.reduce((sum, [key, weight]) => sum + components[key] * weight, 0) / totalWeight)
    : null;
  if (current.stage === 'downtrend-risk' && score !== null) score = Math.min(score, 44);
  if (current.stage === 'extended' && score !== null) score = Math.min(score, 58);
  return {
    ...candidate,
    features:{...candidate.features, earlyOpportunity:{...current, score:metric(score), components}}
  };
}
