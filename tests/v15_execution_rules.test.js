import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEntryTiming, evaluateHolding} from '../research/v15_execution_rules.js';

function candidate(overrides = {}) {
  return {
    code: '000156',
    price: 10.1,
    pct: 1.2,
    ma5: 10,
    ma10: 9.9,
    ma20: 9.7,
    atr: 0.04,
    r5: 0.08,
    r8: 0.14,
    k: [{close: 9.98}, {close: 10.1}],
    ...overrides
  };
}

test('limit-up and sharp intraday rallies are observation-only, never fresh BUY entries', () => {
  const result = evaluateEntryTiming(candidate({
    price: 7.28, pct: 9.97, ma5: 7.24, ma10: 7.35, ma20: 7.28,
    k: [{close: 6.62}, {close: 7.28}]
  }));
  assert.equal(result.pass, false);
  assert.equal(result.nearLimitUp, true);
  assert.ok(result.reasons.some(reason => reason.includes('涨停区')));
  assert.ok(result.pullbackZone);
});

test('overextended moving-average distance and multi-day run-up block chasing', () => {
  const result = evaluateEntryTiming(candidate({price: 10.55, ma5: 10, ma10: 9.9, r5: 0.20, r8: 0.28}));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some(reason => reason.includes('5日线')));
  assert.ok(result.reasons.some(reason => reason.includes('近5个交易日')));
  assert.ok(result.reasons.some(reason => reason.includes('近8个交易日')));
});

test('a normal pullback-ready trend passes the timing gate and returns a lower observation zone', () => {
  const result = evaluateEntryTiming(candidate());
  assert.equal(result.pass, true);
  assert.equal(result.reason, 'entry-ready');
  assert.ok(result.pullbackZone);
  assert.ok(result.pullbackZone.low < result.pullbackZone.high);
  assert.ok(result.pullbackZone.high < 10.1);
});

test('weak trend and high volatility are blocked', () => {
  const result = evaluateEntryTiming(candidate({price: 9.7, ma10: 10, atr: 0.09, pct: -3.2}));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some(reason => reason.includes('10日线')));
  assert.ok(result.reasons.some(reason => reason.includes('止跌')));
  assert.ok(result.reasons.some(reason => reason.includes('ATR')));
});

test('initial ATR stop exits a position when the loss threshold is breached', () => {
  const result = evaluateHolding({price: 9.4, entry: 10, atr: 0.04, days: 2, score: 70, flow5: 1});
  assert.equal(result.action, 'EXIT');
  assert.ok(result.activeStop >= 9.4);
  assert.equal(result.protectionStage, 'initial-atr-stop');
});

test('profit protection raises the stop after a 6 percent favorable move', () => {
  const result = evaluateHolding({
    price: 10.2, entry: 10, atr: 0.04, days: 3, score: 80, flow5: 1,
    bars: [{close: 10.1}, {close: 10.6}]
  });
  assert.equal(result.action, 'HOLD');
  assert.equal(result.protectionStage, 'cost-plus-protection');
  assert.ok(result.activeStop >= 10.05);
});

test('ATR trailing protection exits after a large giveback from the post-entry peak', () => {
  const result = evaluateHolding({
    price: 10.3, entry: 10, atr: 0.04, days: 4, score: 80, flow5: 1,
    bars: [{close: 10.2}, {close: 10.7}, {close: 11.2}, {close: 10.3}]
  });
  assert.equal(result.protectionStage, 'atr-trailing-protection');
  assert.equal(result.action, 'EXIT');
  assert.ok(result.activeStop > 10.3);
});

test('weak structure and persistent outflow exit; fading short-term edge reduces', () => {
  const exit = evaluateHolding({price: 9.7, entry: 10, atr: 0.04, days: 3, score: 60, flow5: -1, ma20: 10});
  assert.equal(exit.action, 'EXIT');
  const reduce = evaluateHolding({price: 10.1, entry: 10, atr: 0.04, days: 3, score: 62, flow3: 1, flow5: 1});
  assert.equal(reduce.action, 'REDUCE');
});

test('five-session time stop exits a stale, unprofitable position', () => {
  const result = evaluateHolding({price: 10.05, entry: 10, atr: 0.04, days: 5, score: 65, flow5: -1});
  assert.equal(result.action, 'EXIT');
  assert.ok(result.reasons.some(reason => reason.includes('时间止损')));
});
