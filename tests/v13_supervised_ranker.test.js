import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trainLogisticRegression, predictProbability, extractFeatureVector, buildPointInTimeRows, splitSignalDates
} from '../research/v13-limitup-precursor/supervised_ranker.js';

function makeHistory(code, name, slope, industry) {
  const bars = [];
  for (let i = 0; i < 45; i++) {
    const close = i < 40 ? 10 + slope * i : bars.at(-1).close * 1.002;
    const previous = bars.length ? bars.at(-1).close : close;
    bars.push({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: previous, high: Math.max(previous, close) * 1.01,
      low: Math.min(previous, close) * 0.99, close,
      volume: i < 34 ? 100 : 160, amount: 120000000, turnoverRate: 5
    });
  }
  return {
    code, name, industry, isST: false, bars,
    flows: bars.map((bar, i) => ({
      date: bar.date, mainNet: slope > 0 ? (i + 1) * 100000 : -100000,
      mainPct: slope > 0 ? 1.5 : -1, amount: bar.amount
    }))
  };
}

test('logistic ranker learns a deterministic separable feature without target labels', () => {
  const samples = [];
  for (let i = 0; i < 240; i++) {
    const y = i >= 120 ? 1 : 0;
    const x = new Array(34).fill(0);
    x[0] = y ? 1 : -1;
    x[1] = y ? 0.5 : -0.5;
    samples.push({ x, y });
  }
  const model = trainLogisticRegression(samples, { epochs: 80 });
  const positive = new Array(34).fill(0);
  positive[0] = 1; positive[1] = 0.5;
  const negative = new Array(34).fill(0);
  negative[0] = -1; negative[1] = -0.5;
  assert.ok(predictProbability(model, positive) > predictProbability(model, negative));
  assert.equal(model.trainingSamples, 240);
});

test('supervised feature builder ignores bars and flows after the signal cutoff', () => {
  const candidates = [
    makeHistory('300006', '样本A', 0.02, '行业A'),
    makeHistory('600001', '样本B', -0.01, '行业A'),
    makeHistory('000001', '样本C', 0.01, '行业B')
  ];
  const asOf = candidates[0].bars[39].date;
  const first = buildPointInTimeRows(candidates, asOf);
  const changed = candidates.map(stock => ({
    ...stock,
    bars: stock.bars.map(bar => ({ ...bar })),
    flows: stock.flows.map(flow => ({ ...flow }))
  }));
  const target = changed.find(stock => stock.code === '300006');
  target.bars[40].close *= 1.5;
  target.bars[40].high *= 1.6;
  target.flows[40].mainNet *= -100;
  const second = buildPointInTimeRows(changed, asOf);
  const a = first.find(row => row.code === '300006');
  const b = second.find(row => row.code === '300006');
  assert.ok(a && b);
  assert.deepEqual(extractFeatureVector(a), extractFeatureVector(b));
});


test('supervised chronological split reserves a five-session purge and a larger test window', () => {
  const short = splitSignalDates(Array.from({ length: 25 }, (_, i) => 'short-' + i));
  assert.equal(short.trainDates.length, 15);
  assert.equal(short.purgeDates.length, 5);
  assert.equal(short.testDates.length, 5);
  const long = splitSignalDates(Array.from({ length: 60 }, (_, i) => 'long-' + i));
  assert.equal(long.trainDates.length, 40);
  assert.equal(long.purgeDates.length, 5);
  assert.equal(long.testDates.length, 15);
  assert.equal(long.trainDates.at(-1), 'long-39');
  assert.equal(long.purgeDates[0], 'long-40');
  assert.equal(long.testDates[0], 'long-45');
});
