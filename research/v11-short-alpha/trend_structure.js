import { asOfDate, clamp, finiteNumber, round } from './schema.js';

export const TREND_STRUCTURE_VERSION = 'Trend Structure Research Factor v1';

const n = finiteNumber;
const HORIZONS = Object.freeze([3, 5, 10, 20]);
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);
const list = value => Array.isArray(value) ? value : [];

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function average(values) {
  const numbers = values.map(n).filter(value => value !== null);
  return mean(numbers);
}

function pct(from, to) {
  return from !== null && to !== null && from > 0 ? (to / from - 1) * 100 : null;
}

function normalizeBar(raw) {
  const fields = typeof raw === 'string' ? raw.split(',') : raw;
  const array = Array.isArray(fields);
  const date = String(array ? fields?.[0] ?? '' : raw?.date ?? raw?.time ?? '');
  const close = n(array ? fields?.[2] : raw?.close ?? raw?.price);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(close > 0)) return null;
  return {
    date,
    open:n(array ? fields?.[1] : raw?.open),
    close,
    high:n(array ? fields?.[3] : raw?.high),
    low:n(array ? fields?.[4] : raw?.low),
    volume:n(array ? fields?.[5] : raw?.volume ?? raw?.vol),
    amount:n(array ? fields?.[6] : raw?.amount ?? raw?.turnover)
  };
}

function validBars(rawBars, options = {}) {
  const rawAsOf = options.asOf ?? options.snapshot?.asOf ?? null;
  const cutoff = asOfDate(rawAsOf);
  const dateOnly = typeof rawAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawAsOf);
  const barComplete = options.barComplete === true;
  const seen = new Set();
  let futureRowsIgnored = 0;
  let sameDayRowsIgnored = 0;
  const bars = [];
  for (const raw of list(rawBars)) {
    const row = normalizeBar(raw);
    if (!row || seen.has(row.date)) continue;
    if (!cutoff) continue;
    if (row.date > cutoff) {
      futureRowsIgnored += 1;
      continue;
    }
    // A date-only snapshot represents a completed session. An intraday timestamp
    // must opt in to the current daily bar explicitly.
    if (!dateOnly && row.date === cutoff && !barComplete) {
      sameDayRowsIgnored += 1;
      continue;
    }
    seen.add(row.date);
    bars.push(row);
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { bars, cutoff, futureRowsIgnored, sameDayRowsIgnored, dateOnly };
}

function rollingMeanAt(bars, endIndex, period) {
  if (endIndex + 1 < period) return null;
  return mean(bars.slice(endIndex - period + 1, endIndex + 1).map(row => row.close));
}

function movingAverage(bars, period) {
  return rollingMeanAt(bars, bars.length - 1, period);
}

function movingAverageSlope(bars, period, lookback = 3) {
  const current = movingAverage(bars, period);
  const previous = rollingMeanAt(bars, bars.length - 1 - lookback, period);
  return current !== null && previous !== null ? pct(previous, current) / lookback : null;
}

function dailyReturns(bars) {
  return bars.slice(1).map((row, index) => pct(bars[index].close, row.close))
    .filter(value => value !== null);
}

function priceLevels(bars) {
  const recent = bars.slice(-3);
  const prior = bars.slice(-6, -3);
  if (recent.length < 3 || prior.length < 3) {
    return { higherHigh:null, higherLow:null, lowerHigh:null, lowerLow:null };
  }
  const highOf = rows => Math.max(...rows.map(row => row.high ?? row.close));
  const lowOf = rows => Math.min(...rows.map(row => row.low ?? row.close));
  const recentHigh = highOf(recent), priorHigh = highOf(prior);
  const recentLow = lowOf(recent), priorLow = lowOf(prior);
  return {
    higherHigh:recentHigh > priorHigh,
    higherLow:recentLow > priorLow,
    lowerHigh:recentHigh < priorHigh,
    lowerLow:recentLow < priorLow
  };
}

function structureScore(structure) {
  const values = [
    structure.higherHigh === true ? 100 : structure.lowerHigh === true ? 0 : null,
    structure.higherLow === true ? 100 : structure.lowerLow === true ? 0 : null
  ].filter(value => value !== null);
  if (!values.length) return null;
  return mean(values);
}

function volumeRatios(bars, returns) {
  const recent = bars.slice(-10);
  const baseline = average(bars.slice(-20).map(row => row.volume));
  if (baseline === null || baseline <= 0) {
    return { upVolumeRatio:null, downVolumeRatio:null, breakoutVolumeRatio:null,
      volumeConfirmationScore:null };
  }
  const paired = recent.slice(1).map((row, index) => ({
    row, change:pct(recent[index].close, row.close)
  }));
  const up = paired.filter(item => item.change !== null && item.change > 0)
    .map(item => item.row.volume).filter(value => value !== null && value > 0);
  const down = paired.filter(item => item.change !== null && item.change < 0)
    .map(item => item.row.volume).filter(value => value !== null && value > 0);
  const upVolumeRatio = up.length ? mean(up) / baseline : null;
  const downVolumeRatio = down.length ? mean(down) / baseline : null;
  const priorHigh = Math.max(...bars.slice(-11, -1).map(row => row.high ?? row.close));
  const last = bars.at(-1);
  const breakout = last && last.close > priorHigh;
  const breakoutVolumeRatio = breakout && last.volume !== null ? last.volume / baseline : null;
  const confirmationParts = [];
  if (upVolumeRatio !== null && downVolumeRatio !== null) {
    confirmationParts.push(clamp(50 + (upVolumeRatio - downVolumeRatio) * 45));
  }
  if (breakoutVolumeRatio !== null) {
    confirmationParts.push(clamp(50 + (breakoutVolumeRatio - 1) * 30));
  }
  return {
    upVolumeRatio:metric(upVolumeRatio),
    downVolumeRatio:metric(downVolumeRatio),
    breakoutVolumeRatio:metric(breakoutVolumeRatio),
    volumeConfirmationScore:confirmationParts.length ? metric(mean(confirmationParts)) : null
  };
}

function pullbackMetrics(bars) {
  if (bars.length < 6) {
    return { pullbackDepth:null, pullbackDuration:null, recoveryStrength:null,
      pullbackVolumeRatio:null, pullbackQualityScore:null };
  }
  const end = bars.length - 1;
  const searchStart = Math.max(0, end - 10);
  let peakIndex = searchStart;
  for (let index = searchStart; index < end; index += 1) {
    const candidate = bars[index].high ?? bars[index].close;
    const peak = bars[peakIndex].high ?? bars[peakIndex].close;
    if (candidate >= peak) peakIndex = index;
  }
  if (peakIndex >= end) {
    return { pullbackDepth:0, pullbackDuration:0, recoveryStrength:100,
      pullbackVolumeRatio:null, pullbackQualityScore:70 };
  }
  let troughIndex = peakIndex;
  for (let index = peakIndex + 1; index <= end; index += 1) {
    const candidate = bars[index].low ?? bars[index].close;
    const trough = bars[troughIndex].low ?? bars[troughIndex].close;
    if (candidate <= trough) troughIndex = index;
  }
  const peak = bars[peakIndex].high ?? bars[peakIndex].close;
  const trough = bars[troughIndex].low ?? bars[troughIndex].close;
  const last = bars[end].close;
  const depth = pct(peak, trough);
  const recovery = peak > trough ? (last - trough) / (peak - trough) * 100 : 100;
  const pullbackBars = bars.slice(peakIndex + 1, troughIndex + 1);
  const baselineBars = bars.slice(Math.max(0, peakIndex - 5), peakIndex);
  const pullbackVolumeRatio = pullbackBars.length
    ? (() => {
      const p = average(pullbackBars.map(row => row.volume));
      const b = average(baselineBars.map(row => row.volume));
      return p !== null && b !== null && b > 0 ? p / b : null;
    })() : null;
  const depthScore = depth === null ? null : clamp(100 - depth * 8);
  const durationScore = clamp(100 - Math.max(0, pullbackBars.length - 2) * 18);
  const recoveryScore = recovery === null ? null : clamp(recovery);
  const volumeScore = pullbackVolumeRatio === null
    ? 60 : clamp(100 - Math.max(0, pullbackVolumeRatio - 0.8) * 70);
  const values = [depthScore, durationScore, recoveryScore, volumeScore].filter(value => value !== null);
  return {
    pullbackDepth:metric(depth),
    pullbackDuration:pullbackBars.length,
    recoveryStrength:metric(recovery),
    pullbackVolumeRatio:metric(pullbackVolumeRatio),
    pullbackQualityScore:values.length ? metric(mean(values)) : null
  };
}

function overextensionMetrics(bars, mas) {
  const last = bars.at(-1)?.close ?? null;
  const distanceFromMA5 = pct(mas.ma5, last);
  const distanceFromMA10 = pct(mas.ma10, last);
  const distanceFromMA20 = pct(mas.ma20, last);
  const prior5 = bars.length >= 11 ? pct(bars.at(-11).close, bars.at(-6).close) : null;
  const recent5 = bars.length >= 6 ? pct(bars.at(-6).close, last) : null;
  const recentAcceleration = recent5 !== null && prior5 !== null ? recent5 - prior5 : null;
  const magnitude = [distanceFromMA5, distanceFromMA10, distanceFromMA20]
    .filter(value => value !== null).map(value => Math.max(0, value));
  const distancePenalty = magnitude.length ? mean(magnitude) : null;
  const accelerationPenalty = recentAcceleration === null ? null : Math.max(0, recentAcceleration);
  const penalty = distancePenalty === null && accelerationPenalty === null ? null
    : (distancePenalty ?? 0) * 3 + (accelerationPenalty ?? 0) * 2;
  return {
    distanceFromMA5:metric(distanceFromMA5),
    distanceFromMA10:metric(distanceFromMA10),
    distanceFromMA20:metric(distanceFromMA20),
    recentAcceleration:metric(recentAcceleration),
    // This is a safety score: high means the trend is not overextended.
    overextensionScore:penalty === null ? null : metric(clamp(100 - penalty))
  };
}

function stageFor(input) {
  const { direction, alignment, persistence, overextension, trend3d, trend5d,
    trend10d, trend20d, structure, volumeConfirmation } = input;
  if (direction === 'unknown') return 'unknown';
  if (direction === 'down' &&
      ((structure.lowerHigh && structure.lowerLow) || persistence.trendBreakCount >= 2)) {
    return 'breakdown';
  }
  if (overextension.overextensionScore !== null && overextension.overextensionScore < 25) {
    return 'exhaustion';
  }
  if (direction === 'up' && trend3d !== null && trend3d > 0 &&
      (trend10d === null || trend10d <= 2) && (volumeConfirmation ?? 50) >= 50) {
    return 'startup';
  }
  if (direction === 'up' && alignment.bullishAlignmentScore !== null &&
      alignment.bullishAlignmentScore >= 66 && trend5d !== null &&
      trend5d > 4 && (overextension.recentAcceleration ?? 0) >= 0) {
    return 'acceleration';
  }
  if (direction === 'up' && alignment.bullishAlignmentScore !== null &&
      alignment.bullishAlignmentScore >= 50 && persistence.trendPersistenceScore !== null &&
      persistence.trendPersistenceScore >= 55) {
    return 'continuation';
  }
  if (direction === 'up') return 'mature';
  return 'neutral';
}

function scoreTrend({alignment, structureScoreValue, persistence, pullback, volume, overextension, confidence}) {
  const parts = [
    [alignment.bullishAlignmentScore, 0.25],
    [structureScoreValue, 0.20],
    [persistence.trendPersistenceScore, 0.20],
    [pullback.pullbackQualityScore, 0.15],
    [volume.volumeConfirmationScore, 0.10],
    [overextension.overextensionScore, 0.10]
  ];
  const available = parts.filter(([, value]) => value !== null);
  if (!available.length || confidence <= 0) return null;
  const weight = available.reduce((sum, [, part]) => sum + part, 0);
  return metric(clamp(available.reduce((sum, [value, part]) => sum + value * part, 0) / weight));
}

export function computeTrendStructure(input = {}, options = {}) {
  const rawBars = input?.bars ?? input?.history ?? options?.bars ?? [];
  const rawAsOf = options.asOf ?? input?.asOf ?? input?.snapshot?.asOf;
  const filtered = validBars(rawBars, { ...options, asOf:rawAsOf });
  const bars = filtered.bars;
  const result = {
    version:TREND_STRUCTURE_VERSION,
    score:null,
    direction:'unknown',
    stage:'unknown',
    trend3d:null, trend5d:null, trend10d:null, trend20d:null,
    ma5:null, ma10:null, ma20:null, ma5Slope:null, ma10Slope:null, ma20Slope:null,
    alignment:{
      priceAboveMa5:null, priceAboveMa10:null, priceAboveMa20:null,
      ma5AboveMa10:null, ma10AboveMa20:null, bullishAlignmentScore:null
    },
    priceStructure:{
      higherHigh:null, higherLow:null, lowerHigh:null, lowerLow:null,
      swingStructureScore:null
    },
    persistence:{
      upDayRatio:null, positiveCloseRatio:null, trendBreakCount:null,
      pullbackCount:null, trendPersistenceScore:null
    },
    pullback:{
      pullbackDepth:null, pullbackDuration:null, recoveryStrength:null,
      pullbackVolumeRatio:null, pullbackQualityScore:null
    },
    volumeConfirmation:{
      upVolumeRatio:null, downVolumeRatio:null, breakoutVolumeRatio:null,
      volumeConfirmationScore:null
    },
    overextension:{
      distanceFromMA5:null, distanceFromMA10:null, distanceFromMA20:null,
      recentAcceleration:null, overextensionScore:null
    },
    confidence:0,
    reasons:[],
    diagnostics:{
      asOfDate:filtered.cutoff, barsUsed:bars.length,
      futureRowsIgnored:filtered.futureRowsIgnored,
      sameDayRowsIgnored:filtered.sameDayRowsIgnored,
      insufficientHistory:bars.length < 6
    }
  };
  if (!filtered.cutoff) {
    result.reasons.push('invalid-or-missing-asof');
    return result;
  }
  if (bars.length < 4) {
    result.reasons.push('insufficient-history');
    return result;
  }

  const closes = bars.map(row => row.close);
  const last = closes.at(-1);
  const trends = Object.fromEntries(HORIZONS.map(period => [
    period, bars.length > period ? pct(closes.at(-period - 1), last) : null
  ]));
  const ma5 = movingAverage(bars, 5), ma10 = movingAverage(bars, 10), ma20 = movingAverage(bars, 20);
  result.trend3d = metric(trends[3]); result.trend5d = metric(trends[5]);
  result.trend10d = metric(trends[10]); result.trend20d = metric(trends[20]);
  result.ma5 = metric(ma5); result.ma10 = metric(ma10); result.ma20 = metric(ma20);
  result.ma5Slope = metric(movingAverageSlope(bars, 5));
  result.ma10Slope = metric(movingAverageSlope(bars, 10));
  result.ma20Slope = metric(movingAverageSlope(bars, 20));

  const priceAboveMa5 = ma5 === null ? null : last > ma5;
  const priceAboveMa10 = ma10 === null ? null : last > ma10;
  const priceAboveMa20 = ma20 === null ? null : last > ma20;
  const ma5AboveMa10 = ma5 !== null && ma10 !== null ? ma5 > ma10 : null;
  const ma10AboveMa20 = ma10 !== null && ma20 !== null ? ma10 > ma20 : null;
  const alignmentValues = [priceAboveMa5, priceAboveMa10, priceAboveMa20,
    ma5AboveMa10, ma10AboveMa20].filter(value => value !== null);
  const bullishAlignmentScore = alignmentValues.length
    ? metric(alignmentValues.filter(Boolean).length / alignmentValues.length * 100) : null;
  const alignment = {
    priceAboveMa5, priceAboveMa10, priceAboveMa20,
    ma5AboveMa10, ma10AboveMa20, bullishAlignmentScore
  };
  result.alignment = alignment;

  const priceStructure = priceLevels(bars);
  priceStructure.swingStructureScore = metric(structureScore(priceStructure));
  result.priceStructure = priceStructure;

  const returns = dailyReturns(bars);
  const upDayRatio = returns.length ? returns.filter(value => value > 0).length / returns.length * 100 : null;
  const positiveCloseRatio = returns.length
    ? returns.filter(value => value >= 0).length / returns.length * 100 : null;
  let trendBreakCount = 0;
  let pullbackCount = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const priorMa5 = rollingMeanAt(bars, index - 1, 5);
    const currentMa5 = rollingMeanAt(bars, index, 5);
    const priorAbove = priorMa5 !== null && bars[index - 1].close >= priorMa5;
    const currentBelow = currentMa5 !== null && bars[index].close < currentMa5;
    if (priorAbove && currentBelow) trendBreakCount += 1;
    if (returns[index - 1] < 0 && index >= 2 && returns[index - 2] > 0) pullbackCount += 1;
  }
  const breakPenalty = Math.min(100, trendBreakCount * 25);
  const pullbackPenalty = Math.min(50, pullbackCount * 5);
  const trendPersistenceScore = returns.length
    ? metric(clamp(upDayRatio * 0.70 + (100 - breakPenalty) * 0.20 +
      (100 - pullbackPenalty) * 0.10)) : null;
  const persistence = {
    upDayRatio:metric(upDayRatio), positiveCloseRatio:metric(positiveCloseRatio),
    trendBreakCount, pullbackCount, trendPersistenceScore
  };
  result.persistence = persistence;

  const pullback = pullbackMetrics(bars);
  result.pullback = pullback;

  const volume = volumeRatios(bars, returns);
  result.volumeConfirmation = volume;

  const overextension = overextensionMetrics(bars, {
    ma5, ma10, ma20
  });
  result.overextension = overextension;

  const directionValues = [trends[5], trends[10], trends[20]].filter(value => value !== null);
  const directionAverage = mean(directionValues);
  const direction = directionAverage === null ? 'unknown'
    : directionAverage > 1 ? 'up' : directionAverage < -1 ? 'down' : 'sideways';
  result.direction = direction;

  const availableGroups = [
    alignment.bullishAlignmentScore, priceStructure.swingStructureScore,
    persistence.trendPersistenceScore, pullback.pullbackQualityScore,
    volume.volumeConfirmationScore, overextension.overextensionScore
  ];
  const confidence = availableGroups.filter(value => value !== null).length / availableGroups.length;
  result.confidence = metric(confidence);
  result.stage = stageFor({
    direction, alignment, persistence, overextension,
    trend3d:trends[3], trend5d:trends[5], trend10d:trends[10],
    trend20d:trends[20], structure:priceStructure,
    volumeConfirmation:volume.volumeConfirmationScore
  });
  result.score = scoreTrend({
    alignment, structureScoreValue:priceStructure.swingStructureScore,
    persistence, pullback, volume, overextension, confidence
  });

  const reasons = [];
  if (alignment.bullishAlignmentScore !== null && alignment.bullishAlignmentScore >= 80) reasons.push('bullish-ma-alignment');
  if (priceStructure.higherHigh && priceStructure.higherLow) reasons.push('higher-high-higher-low');
  if (persistence.trendPersistenceScore !== null && persistence.trendPersistenceScore >= 70) reasons.push('persistent-up-days');
  if (pullback.pullbackQualityScore !== null && pullback.pullbackQualityScore >= 70) reasons.push('pullback-recovered');
  if (volume.volumeConfirmationScore !== null && volume.volumeConfirmationScore >= 65) reasons.push('volume-confirms-trend');
  if (overextension.overextensionScore !== null && overextension.overextensionScore < 35) reasons.push('overextension-risk');
  if (persistence.trendBreakCount >= 2) reasons.push('trend-breakdown-risk');
  if (!result.score) reasons.push('insufficient-trend-evidence');
  result.reasons = reasons;
  return result;
}

export function withTrendStructure(candidate = {}, bars = [], options = {}) {
  const trendStructure = computeTrendStructure({ bars, asOf:candidate?.asOf }, {
    ...options, asOf:options.asOf ?? candidate?.asOf
  });
  return {
    ...candidate,
    features:{
      ...(candidate.features ?? {}),
      trendStructure
    }
  };
}

export { normalizeBar, validBars, movingAverage, movingAverageSlope, priceLevels };
