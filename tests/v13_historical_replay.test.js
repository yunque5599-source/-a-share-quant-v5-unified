import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKlineRows, parseFlowRows, addHistoricalIndustryContext } from '../research/v13-limitup-precursor/historical_replay.js';

test('historical K-line parser excludes bars after the signal cutoff and sorts by date', () => {
  const rows = [
    '2026-10-21,9,10,10,8.8,200,2000000,10,20,1,6',
    '2026-10-19,8,8.5,8.6,7.9,100,850000,8,2,0.1,3',
    '2026-10-20,8.5,9,9.1,8.4,120,1080000,8,5,0.5,4'
  ];
  const bars = parseKlineRows(rows, '2026-10-20');
  assert.deepEqual(bars.map(row => row.date), ['2026-10-19', '2026-10-20']);
  assert.equal(bars[1].close, 9);
  assert.equal(bars[1].turnoverRate, 4);
});

test('historical fund-flow parser drops post-cutoff data and joins turnover by date', () => {
  const rows = [
    '2026-10-21,900,0,0,0,0,90,0,0,0,0,10,5',
    '2026-10-20,500,0,0,0,0,4.2,0,0,0,0,9,2'
  ];
  const bars = [{ date: '2026-10-20', amount: 1200000 }];
  const flows = parseFlowRows(rows, '2026-10-20', bars);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].mainNet, 500);
  assert.equal(flows[0].mainPct, 4.2);
  assert.equal(flows[0].amount, 1200000);
});

test('industry breadth and leader scores are derived only from supplied pre-event bars', () => {
  const stock = (code, name, industry, closes, dailyClose) => ({
    code, name, industry, board: 'SZ_MAIN',
    bars: closes.map((close, i) => ({
      date: '2026-10-' + String(15 + i).padStart(2, '0'),
      open: close, close, high: close * 1.01, low: close * 0.99,
      volume: 100, amount: 100000000
    })).concat([{
      date: '2026-10-20', open: closes.at(-1), close: dailyClose,
      high: dailyClose * 1.01, low: dailyClose * 0.99, volume: 200, amount: 200000000
    }])
  });
  const input = [
    stock('000001', 'A', 'IndustryX', [10, 10.1, 10.2, 10.3, 10.4], 10.8),
    stock('000002', 'B', 'IndustryX', [10, 9.9, 9.8, 9.7, 9.6], 9.5)
  ];
  const output = addHistoricalIndustryContext(input);
  assert.equal(output[0].sector.return3Pct, output[1].sector.return3Pct);
  assert.ok(output[0].sector.leaderScore > output[1].sector.leaderScore);
  assert.equal(output[0].sector.limitUpCount, 0);
});
