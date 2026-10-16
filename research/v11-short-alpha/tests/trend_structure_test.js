import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTrendStructure, withTrendStructure } from '../trend_structure.js';
import { scoreCandidate } from '../alpha_score.js';

function barsFromCloses(closes, options = {}) {
  const start = options.start ?? '2026-01-01';
  return closes.map((close, index) => {
    const day = String(index + 1).padStart(2, '0');
    const date = start.slice(0, 8) + day;
    const volume = options.volume?.(index, close) ?? 1000;
    const highOffset = options.highOffset?.(index) ?? 1;
    const lowOffset = options.lowOffset?.(index) ?? 1;
    return {
      date, open:close, close,
      high:close + highOffset, low:Math.max(0.01, close - lowOffset),
      volume, amount:volume * close
    };
  });
}

function risingBars() {
  return barsFromCloses(Array.from({length:30}, (_, index) => 100 + index * 1.5));
}

function fallingBars() {
  return barsFromCloses(Array.from({length:30}, (_, index) => 150 - index * 1.5));
}

function scoreOf(result) {
  return result.score === null ? null : Number(result.score);
}

function numericFields(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numericFields);
  if (typeof value === 'object') return Object.values(value).flatMap(numericFields);
  return [];
}

test('clean advance has bullish MA alignment, positive slopes and higher highs/lows', () => {
  const result = computeTrendStructure({bars:risingBars(), asOf:'2026-01-30'});
  assert.equal(result.direction, 'up');
  assert.ok(['continuation', 'acceleration', 'mature'].includes(result.stage));
  assert.ok(result.ma5 > result.ma10 && result.ma10 > result.ma20);
  assert.ok(result.ma5Slope > 0 && result.ma10Slope > 0 && result.ma20Slope > 0);
  assert.equal(result.alignment.priceAboveMa5, true);
  assert.equal(result.alignment.priceAboveMa10, true);
  assert.equal(result.alignment.priceAboveMa20, true);
  assert.equal(result.alignment.ma5AboveMa10, true);
  assert.equal(result.alignment.ma10AboveMa20, true);
  assert.equal(result.priceStructure.higherHigh, true);
  assert.equal(result.priceStructure.higherLow, true);
  assert.ok(result.priceStructure.swingStructureScore >= 75);
});

test('falling structure detects lower highs/lows and breakdown', () => {
  const result = computeTrendStructure({bars:fallingBars(), asOf:'2026-01-30'});
  assert.equal(result.direction, 'down');
  assert.equal(result.priceStructure.lowerHigh, true);
  assert.equal(result.priceStructure.lowerLow, true);
  assert.ok(['breakdown', 'neutral'].includes(result.stage));
  assert.ok((scoreOf(result) ?? 0) < 60);
});

test('shallow recovery scores pullback quality above deep high-volume failure', () => {
  const good = [...Array.from({length:24}, (_, index) => 100 + index),
    124, 122, 123, 125, 127, 129];
  const bad = [...Array.from({length:24}, (_, index) => 100 + index),
    124, 112, 108, 110, 111, 110];
  const goodResult = computeTrendStructure({
    bars:barsFromCloses(good, {volume:index => index >= 24 ? 600 : 1000}),
    asOf:'2026-01-30'
  });
  const badResult = computeTrendStructure({
    bars:barsFromCloses(bad, {volume:index => index >= 24 ? 2500 : 1000}),
    asOf:'2026-01-30'
  });
  assert.ok((goodResult.pullback.pullbackDepth ?? 0) < (badResult.pullback.pullbackDepth ?? Infinity));
  assert.ok((goodResult.pullback.pullbackQualityScore ?? 0) >
    (badResult.pullback.pullbackQualityScore ?? 0));
  assert.ok((goodResult.pullback.recoveryStrength ?? 0) >
    (badResult.pullback.recoveryStrength ?? 0));
});

test('volume confirmation rewards a high-volume breakout over a dry breakout', () => {
  const closes = [...Array.from({length:29}, (_, index) => 100 + index * 0.5), 118];
  const highVolume = computeTrendStructure({
    bars:barsFromCloses(closes, {volume:index => index === 29 ? 8000 : 1000}),
    asOf:'2026-01-30'
  });
  const lowVolume = computeTrendStructure({
    bars:barsFromCloses(closes, {volume:index => index === 29 ? 100 : 1000}),
    asOf:'2026-01-30'
  });
  assert.ok((highVolume.volumeConfirmation.breakoutVolumeRatio ?? 0) >
    (lowVolume.volumeConfirmation.breakoutVolumeRatio ?? 0));
  assert.ok((highVolume.volumeConfirmation.volumeConfirmationScore ?? 0) >
    (lowVolume.volumeConfirmation.volumeConfirmationScore ?? 0));
});

test('overextension lowers safety score and does not equal a clean trend', () => {
  const normal = risingBars();
  const extendedCloses = [...Array.from({length:29}, (_, index) => 100 + index * 0.2), 180];
  const extended = barsFromCloses(extendedCloses, {highOffset:() => 8, lowOffset:() => 8});
  const normalResult = computeTrendStructure({bars:normal, asOf:'2026-01-30'});
  const extendedResult = computeTrendStructure({bars:extended, asOf:'2026-01-30'});
  assert.ok((extendedResult.overextension.distanceFromMA5 ?? 0) >
    (normalResult.overextension.distanceFromMA5 ?? 0));
  assert.ok((extendedResult.overextension.overextensionScore ?? 100) <
    (normalResult.overextension.overextensionScore ?? 0));
  assert.ok((scoreOf(extendedResult) ?? 100) < (scoreOf(normalResult) ?? 0));
  assert.equal(extendedResult.stage, 'exhaustion');
});

test('future and incomplete same-day bars are excluded from trend features', () => {
  const base = risingBars();
  const withFuture = [...base,
    {date:'2026-02-01', open:200, close:300, high:350, low:190, volume:99999}
  ];
  const baseline = computeTrendStructure({bars:base, asOf:'2026-01-30'});
  const future = computeTrendStructure({bars:withFuture, asOf:'2026-01-30'});
  assert.deepEqual({...future, diagnostics:{...future.diagnostics, futureRowsIgnored:0}},
    {...baseline, diagnostics:{...baseline.diagnostics, futureRowsIgnored:0}});
  const intraday = computeTrendStructure({
    bars:[...base, {date:'2026-01-30', close:999, high:1000, low:998, volume:99999}],
    asOf:'2026-01-30T03:00:00Z'
  });
  assert.equal(intraday.diagnostics.sameDayRowsIgnored, 1);
  assert.equal(intraday.diagnostics.barsUsed, 29);
});

test('missing history and malformed OHLCV fail safely with bounded output', () => {
  const short = computeTrendStructure({
    bars:[{date:'2026-01-01', close:10}, {date:'2026-01-02', close:null},
      {date:'bad', close:12}, {date:'2026-01-03', close:11}],
    asOf:'2026-01-03'
  });
  assert.equal(short.score, null);
  assert.ok(short.reasons.includes('insufficient-history'));
  const malformed = computeTrendStructure({
    bars:[...risingBars(), {date:'2026-01-30', close:NaN, high:NaN, low:NaN}],
    asOf:'2026-01-30'
  });
  assert.ok(malformed.reasons.every(reason => typeof reason === 'string'));
  assert.ok(numericFields(malformed).every(value => Number.isFinite(value)));
});

test('score and confidence stay within their declared bounds', () => {
  const result = computeTrendStructure({bars:risingBars(), asOf:'2026-01-30'});
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(result.reasons.every(reason => typeof reason === 'string'));
});

test('trend research feature survives candidate scoring without changing V12 scores', () => {
  const trend = computeTrendStructure({bars:risingBars(), asOf:'2026-01-30'});
  const candidate = withTrendStructure({
    asOf:'2026-01-30', symbol:'600001', price:145,
    scores:{v12Trade:82, v12TradeRaw:82, v12Selection:80, v12SelectionRaw:80},
    features:{momentum:{return5dPct:8}}
  }, risingBars(), {asOf:'2026-01-30'});
  assert.deepEqual(candidate.scores, {
    v12Trade:82, v12TradeRaw:82, v12Selection:80, v12SelectionRaw:80
  });
  assert.equal(candidate.features.momentum.return5dPct, 8);
  assert.equal(candidate.features.trendStructure.score, trend.score);
  const scored = scoreCandidate({
    asOf:'2026-01-30', symbol:'600001', price:145,
    features:{
      capital:{score:80}, momentum:{score:75}, sector:{score:70},
      volume:{score:65}, risk:{score:60}, trendStructure:trend
    }
  });
  assert.equal(scored.features.trendStructure.score, trend.score);
  assert.equal(scored.scores.alphaRaw, 72.25);
});
