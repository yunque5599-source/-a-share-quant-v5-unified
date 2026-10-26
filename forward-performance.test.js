import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateForwardSample, summarizeByRegime } from './forward-performance.js';

const bars = [
  { date: '2026-10-26', close: 10, high: 10.2, low: 9.8 },
  { date: '2026-10-27', close: 10.5, high: 10.8, low: 10.0 },
  { date: '2026-10-28', close: 10.2, high: 10.7, low: 10.1 },
  { date: '2026-10-29', close: 10.8, high: 11.0, low: 10.2 },
  { date: '2026-10-30', close: 10.4, high: 10.9, low: 10.0 },
  { date: '2026-11-02', close: 11.0, high: 11.2, low: 10.3 }
];

test('forward returns start strictly after signal date', () => {
  const s = evaluateForwardSample({ date: '2026-10-26', price: 10, regimeState: '牛市主升' }, bars);
  assert.equal(s.forward.r1, 0.05);
  assert.equal(s.forward.date1, '2026-10-27');
  assert.equal(s.forward.r3, 0.08);
  assert.equal(s.forward.r5, 0.1);
});

test('incomplete horizons remain unscored and current partial bar can be excluded', () => {
  const s = evaluateForwardSample({ date: '2026-10-29', price: 10.8 }, bars, { asOfDate: '2026-11-02', excludeCurrentDay: true });
  assert.equal(Object.hasOwn(s.forward || {}, 'r1'), true);
  assert.equal(Object.hasOwn(s.forward || {}, 'r3'), false);
  assert.equal(Object.hasOwn(s.forward || {}, 'r5'), false);
});

test('frozen forward outcomes are never overwritten', () => {
  const s = evaluateForwardSample({ date: '2026-10-26', price: 10, forward: { r1: 0.123 } }, bars);
  assert.equal(s.forward.r1, 0.123);
});

test('summaries group by market state and report only matured observations', () => {
  const rows = [
    { market: '熊市下跌', forward: { r1: -0.02, r3: 0.01, mae5: -0.05 } },
    { market: '熊市下跌', forward: { r1: 0.03, r3: -0.01, mae5: -0.03 } },
    { market: '牛市主升', forward: { r1: 0.02 } }
  ];
  const summary = summarizeByRegime(rows);
  const bear = summary.find(x => x.state === '熊市下跌');
  const bull = summary.find(x => x.state === '牛市主升');
  assert.equal(bear.signalCount, 2);
  assert.equal(bear.horizons[0].n, 2);
  assert.equal(bear.horizons[0].winRate, 0.5);
  assert.equal(bear.horizons[2].n, 0);
  assert.equal(bull.horizons[0].n, 1);
  assert.equal(bull.horizons[1].n, 0);
});

test('invalid sample data is returned unchanged', () => {
  const sample = { date: 'bad-date', price: 0 };
  assert.equal(evaluateForwardSample(sample, bars), sample);
});
