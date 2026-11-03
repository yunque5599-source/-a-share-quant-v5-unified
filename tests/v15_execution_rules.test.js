import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEntryTiming, evaluateHolding} from '../research/v15_execution_rules.js';

function candidate(overrides = {}) {
  return {
    code: '000156',
    price: 10,
    pct: 1.2,
    ma5: 10,
    ma10: 9.9,
    ma20: 9.7,
    atr: 0.04,
    r5: 0.08,
    r8: 0.14,
    flow3: 1,
    flow5: 2,
    k: [
      {date: '2026-11-02', open: 10.02, high: 10.10, low: 9.85, close: 10.00}
    ],
    ...overrides
  };
}

test('limit-up and sharp intraday rallies are observation-only, never fresh BUY entries', () => {
  const result = evaluateEntryTiming(candidate({
    price: 7.28, pct: 9.97, ma5: 7.24, ma10: 7.35, ma20: 7.28,
    k: [
      {date: '2026-10-30', open: 6.62, high: 6.80, low: 6.50, close: 6.62},
      {date: '2026-11-02', open: 6.64, high: 7.28, low: 6.56, close: 7.28}
    ]
  }));
  assert.equal(result.pass, false);
  assert.equal(result.nearLimitUp, true);
  assert.ok(result.reasons.some(reason => reason.includes('涨停区')));
});

test('overextended moving-average distance and multi-day run-up block chasing', () => {
  const result = evaluateEntryTiming(candidate({price: 10.55, ma5: 10, ma10: 9.9, r5: 0.20, r8: 0.28}));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some(reason => reason.includes('5日线')));
  assert.ok(result.reasons.some(reason => reason.includes('近5个交易日')));
  assert.ok(result.reasons.some(reason => reason.includes('近8个交易日')));
});

test('a high score does not authorize an entry before price actually reaches the pullback zone', () => {
  const result = evaluateEntryTiming(candidate({price: 10.25}));
  assert.equal(result.pass, false);
  assert.ok(result.pullbackZone);
  assert.ok(result.reasons.some(reason => reason.includes('尚未回踩')));
});

test('confirmed pullback requires price in zone, a 5-day reclaim, strong close and non-negative flow', () => {
  const result = evaluateEntryTiming(candidate());
  assert.equal(result.pass, true);
  assert.equal(result.reason, 'confirmed-pullback-entry');
  assert.equal(result.setup, 'confirmed-pullback');
  assert.ok(result.pullbackZone.low < result.pullbackZone.high);
});

test('touching the zone without a strong close or positive flow is not an entry', () => {
  const result = evaluateEntryTiming(candidate({
    flow3: -1,
    flow5: -2,
    k: [{date: '2026-11-02', open: 10.0, high: 10.05, low: 9.85, close: 9.90}]
  }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some(reason => reason.includes('收盘位置偏弱')) || result.reasons.some(reason => reason.includes('站回5日线')));
  assert.ok(result.reasons.some(reason => reason.includes('资金均为净流出')));
});

test('weak trend and high volatility are blocked', () => {
  const result = evaluateEntryTiming(candidate({price: 9.7, ma10: 10, atr: 0.09, pct: -3.2}));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some(reason => reason.includes('10日线')));
  assert.ok(result.reasons.some(reason => reason.includes('止跌')));
  assert.ok(result.reasons.some(reason => reason.includes('ATR')));
});

test('initial ATR stop exits a position when the current price breaches the stop', () => {
  const result = evaluateHolding({price: 9.4, entry: 10, atr: 0.04, days: 2, score: 70, flow5: 1});
  assert.equal(result.action, 'EXIT');
  assert.ok(result.activeStop >= 9.4);
  assert.equal(result.protectionStage, 'initial-atr-stop');
});

test('entry-date audit detects a prior stop breach even if the current price rebounds', () => {
  const bars = [
    {date: '2026-10-26', high: 10.10, low: 9.90, close: 10.00},
    {date: '2026-10-27', high: 10.15, low: 9.95, close: 10.05},
    {date: '2026-10-28', high: 10.20, low: 9.95, close: 10.10},
    {date: '2026-10-29', high: 10.05, low: 9.30, close: 9.60},
    {date: '2026-10-30', high: 9.90, low: 9.50, close: 9.70},
    {date: '2026-11-02', high: 11.00, low: 9.65, close: 10.90}
  ];
  const result = evaluateHolding({
    price: 10.90, entry: 10, entryDate: '2026-10-28', days: 3, atr: 0.04,
    bars, score: 82, flow5: 1
  });
  assert.equal(result.action, 'EXIT');
  assert.equal(result.stopHit.date, '2026-10-29');
  assert.ok(result.stopHit.low < result.stopHit.level);
});

test('profit protection uses post-entry highs and exits on a later giveback', () => {
  const bars = [
    {date: '2026-10-28', high: 10.05, low: 9.95, close: 10.00},
    {date: '2026-10-29', high: 10.70, low: 10.30, close: 10.60},
    {date: '2026-10-30', high: 11.20, low: 10.80, close: 11.00},
    {date: '2026-11-02', high: 11.10, low: 10.50, close: 10.60}
  ];
  const result = evaluateHolding({
    price: 10.60, entry: 10, entryDate: '2026-10-28', days: 3, atr: 0.04,
    bars, score: 80, flow5: 1
  });
  assert.equal(result.action, 'EXIT');
  assert.equal(result.stopHit.date, '2026-11-02');
  assert.equal(result.protectionStage, 'atr-trailing-protection');
  assert.ok(result.peakHigh >= 11.2);
});

test('holding review warns when entry date is missing and does not claim historical stop reconstruction', () => {
  const result = evaluateHolding({price: 10.2, entry: 10, atr: 0.04, days: 2, score: 75, flow5: 1});
  assert.equal(result.stopHit, null);
  assert.equal(result.entryDateFound, false);
  assert.ok(result.reasons.some(reason => reason.includes('未填写买入日期')));
});

test('five-session time stop exits a stale, unprofitable position', () => {
  const result = evaluateHolding({price: 10.05, entry: 10, atr: 0.04, days: 5, score: 65, flow5: -1});
  assert.equal(result.action, 'EXIT');
  assert.ok(result.reasons.some(reason => reason.includes('时间止损')));
});
