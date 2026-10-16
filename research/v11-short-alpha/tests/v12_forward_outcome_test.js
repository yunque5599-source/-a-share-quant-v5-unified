import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDailyBars,
  forwardBars,
  evaluateOne,
  aggregate
} from '../evaluate_v12_snapshot.js';

test('forward bars exclude snapshot date to prevent same-day lookahead', () => {
  const bars = parseDailyBars([
    '2026-10-16,10,10,11,9,100,1000',
    '2026-10-19,10,11,12,10,100,1100',
    '2026-10-20,11,12,13,11,100,1200',
    '2026-10-21,12,13,13,10,100,1300',
    '2026-10-22,11,13,14,11,100,1300',
    '2026-10-23,13,14,15,12,100,1400'
  ]);
  const future = forwardBars(bars, '2026-10-16');
  assert.deepEqual(future.map(row => row.date), [
    '2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'
  ]);
});

test('outcome evaluator uses snapshot price and computes T+1/T+3/T+5 plus MFE/MAE', () => {
  const bars = parseDailyBars([
    '2026-10-16,10,10,11,9,100,1000',
    '2026-10-19,10,11,12,10,100,1100',
    '2026-10-20,11,12,13,11,100,1200',
    '2026-10-21,12,13,13,10,100,1300',
    '2026-10-22,11,13,14,11,100,1300',
    '2026-10-23,13,14,15,12,100,1400'
  ]);
  const result = evaluateOne({
    symbol:'600001', name:'测试股', tradeRank:1,
    asOf:'2026-10-16T10:00:00+08:00', price:10
  }, bars);
  assert.ok(Math.abs(result.horizons.t1.returnPct - 10) < 1e-9);
  assert.ok(Math.abs(result.horizons.t3.returnPct - 30) < 1e-9);
  assert.ok(Math.abs(result.horizons.t5.returnPct - 40) < 1e-9);
  assert.ok(Math.abs(result.maxFavorableReturn5d - 50) < 1e-9);
  assert.ok(Math.abs(result.maxAdverseReturn5d - 0) < 1e-9);
  assert.equal(result.outcomeStatus, 'complete');
});

test('aggregate reports win rate and mean forward return without fabricating missing horizons', () => {
  const rows = [
    evaluateOne({symbol:'600001',asOf:'2026-10-16',price:10}, parseDailyBars([
      '2026-10-19,10,11,11,9,100,1000',
      '2026-10-20,11,12,12,10,100,1000',
      '2026-10-21,12,13,13,11,100,1000',
      '2026-10-22,13,14,14,12,100,1000',
      '2026-10-23,14,15,15,13,100,1000'
    ])),
    evaluateOne({symbol:'600002',asOf:'2026-10-16',price:20}, parseDailyBars([
      '2026-10-19,20,19,20,18,100,1000',
      '2026-10-20,19,18,19,17,100,1000',
      '2026-10-21,18,17,18,16,100,1000',
      '2026-10-22,17,16,17,15,100,1000',
      '2026-10-23,16,15,16,14,100,1000'
    ]))
  ];
  const summary = aggregate(rows);
  assert.equal(summary.count, 2);
  assert.equal(summary.horizons.t1.n, 2);
  assert.ok(Math.abs(summary.horizons.t1.avgReturnPct - 2.5) < 1e-9);
  assert.equal(summary.horizons.t1.winRatePct, 50);
});
