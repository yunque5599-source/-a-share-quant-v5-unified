import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replayForwardReturns } from '../forward_return_replay.js';
import { calculateExitScore, evaluateExitAtDate } from '../exit_score.js';
import { run } from '../run.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/short_alpha.json', import.meta.url), 'utf8'));
const replayInput = fixture.replay;
const sessions = replayInput.sessions;
const healthy = {
  entryPrice: 100, currentPrice: 102, peakPrice: 102, daysHeld: 1,
  trendBreak: false, flowWeakening: false, liquidityStress: false,
  marketRisk: 'normal'
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, actual + ' vs ' + expected);

test('T+1/5/20 use exchange sessions across weekends and holiday gaps', () => {
  const result = replayForwardReturns(replayInput);
  const first = result.outcomes[0];
  assert.equal(first.horizons['T+1'].targetDate, '2026-03-09');
  assert.equal(first.horizons['T+5'].targetDate, sessions[5]);
  assert.equal(first.horizons['T+20'].targetDate, sessions[20]);
  assert.equal(first.horizons['T+20'].status, 'COMPLETED');
  const gap = replayForwardReturns({
    sessions: ['2026-09-30', '2026-10-09', '2026-10-12'],
    horizons: [1], predictions: [{ date: '2026-09-30', symbol: 'A' }],
    prices: { A: [{ date: '2026-09-30', close: 10 }, { date: '2026-10-09', close: 11 }] }
  });
  assert.equal(gap.outcomes[0].horizons['T+1'].targetDate, '2026-10-09');
});

test('net proceeds apply costs to both sides, win and mean exclude pending', () => {
  const result = replayForwardReturns({ ...replayInput, costBps: 10 });
  const t1 = result.outcomes[0].horizons['T+1'];
  closeTo(t1.grossReturnPct, 10);
  closeTo(t1.netReturnPct, (110 * 0.999 / (100 * 1.001) - 1) * 100);
  assert.equal(result.statistics['T+1'].evaluated, 1);
  assert.equal(result.statistics['T+1'].pending, 1);
  assert.equal(result.statistics['T+1'].winRatePct, 100);
  closeTo(result.statistics['T+1'].averageReturnPct, t1.netReturnPct);
});

test('drawdown is peak-to-later-close; MAE and MFE use reference close', () => {
  const result = replayForwardReturns({
    sessions: sessions.slice(0, 3), horizons: [2],
    predictions: [{ date: sessions[0], symbol: 'A' }],
    prices: { A: [{ date: sessions[0], close: 10 }, { date: sessions[1], close: 12 }, { date: sessions[2], close: 9 }] }
  });
  const outcome = result.outcomes[0].horizons['T+2'];
  assert.equal(outcome.maxDrawdownPct, 25);
  assert.equal(outcome.maxAdverseExcursionPct, -10);
  assert.equal(outcome.maxFavorableExcursionPct, 20);
});

test('missing target never shifts to the next quote; missing path has no drawdown claim', () => {
  const input = structuredClone(replayInput);
  input.prices.AAA = input.prices.AAA.filter(row => row.date !== sessions[1]);
  const result = replayForwardReturns(input);
  assert.equal(result.outcomes[0].horizons['T+1'].reason, 'target-price-missing');
  const t5 = result.outcomes[0].horizons['T+5'];
  assert.equal(t5.status, 'COMPLETED');
  assert.equal(t5.pathComplete, false);
  assert.equal(t5.maxDrawdownPct, null);
  assert.equal(result.statistics['T+5'].pathEvaluated, 0);
});

test('asOf ignores future prices and cannot fill a missing entry from later bars', () => {
  const limited = replayForwardReturns({ ...replayInput, asOf: sessions[1] });
  assert.equal(limited.outcomes[0].horizons['T+5'].reason, 'target-after-asof');
  const noEntry = replayForwardReturns({
    sessions, horizons: [1], predictions: [{ date: sessions[0], symbol: 'X' }],
    prices: { X: [{ date: sessions[1], close: 200 }] }
  });
  assert.equal(noEntry.outcomes[0].horizons['T+1'].reason, 'entry-price-missing');
  const bad = replayForwardReturns({
    ...replayInput,
    predictions: [{ date: sessions[0], asOfDate: sessions[1], symbol: 'AAA' }]
  });
  assert.equal(bad.diagnostics.rejectedPredictions, 1);
});

test('duplicate forecasts keep first; conflicting quote dates remain unavailable', () => {
  const input = structuredClone(replayInput);
  input.predictions.push({ date: sessions[0], symbol: 'AAA', entryPrice: 999 });
  input.prices.AAA.push({ date: sessions[1], close: 999 });
  const result = replayForwardReturns(input);
  assert.equal(result.diagnostics.duplicatePredictions, 1);
  assert.equal(result.outcomes[0].entryPrice, 100);
  assert.equal(result.outcomes[0].horizons['T+1'].reason, 'target-price-missing');
  assert.deepEqual(result.diagnostics.duplicatePriceDates.AAA, [sessions[1]]);
});

test('accept CORE prediction document and Eastmoney daily kline envelope', () => {
  const result = replayForwardReturns({
    observations: {
      sessions: sessions.slice(0, 2),
      prices: { AAA: { data: { klines: [sessions[0] + ',99,100,101,98,1000,100000', sessions[1] + ',100,110,111,99,2000,200000'] } } }
    },
    horizons: [1],
    predictions: { date: sessions[0], decision: 'BUY', predictions: [{ stock: 'AAA', score: 94 }] }
  });
  assert.equal(result.outcomes[0].decision, 'BUY');
  assert.equal(result.outcomes[0].horizons['T+1'].grossReturnPct, 10);
});

test('reject invalid calendar/cost/horizon and handle zero or invalid price safely', () => {
  assert.throws(() => replayForwardReturns({ sessions: ['2026-02-30'] }), TypeError);
  assert.throws(() => replayForwardReturns({ sessions: [sessions[0], sessions[0]] }), TypeError);
  assert.throws(() => replayForwardReturns({ ...replayInput, costBps: -1 }), TypeError);
  assert.throws(() => replayForwardReturns({ ...replayInput, horizons: [0] }), TypeError);
  const result = replayForwardReturns({ sessions: sessions.slice(0, 2), horizons: [1], predictions: [{ date: sessions[0], symbol: 'A', entryPrice: 'bad' }], prices: { A: [{ date: sessions[1], close: 0 }] } });
  assert.equal(result.outcomes[0].horizons['T+1'].reason, 'entry-price-missing');
});

test('valid healthy position HOLD; severe breakdown EXIT with explainable components', () => {
  assert.equal(calculateExitScore(healthy).action, 'HOLD');
  const result = calculateExitScore({ ...healthy, currentPrice: 90, peakPrice: 110, trendBreak: true, flowWeakening: true, marketRisk: 'weak' });
  assert.equal(result.action, 'EXIT');
  assert.equal(result.canSell, true);
  assert.equal(result.exitScore, 100);
  assert.ok(result.reasons.includes('stop-loss'));
});

test('thresholds include exact TRIM=45 and EXIT=70 boundaries', () => {
  const trim = calculateExitScore({ ...healthy, trendBreak: true, flowWeakening: true, daysHeld: 10 });
  assert.equal(trim.exitScore, 45);
  assert.equal(trim.action, 'TRIM');
  const exit = calculateExitScore({ ...healthy, trendBreak: true, flowWeakening: true, daysHeld: 10, marketRisk: 'weak' });
  assert.equal(exit.exitScore, 70);
  assert.equal(exit.action, 'EXIT');
});

test('stop loss and maximum sessions force EXIT; A-share T+1 blocks same-day selling', () => {
  const loss = calculateExitScore({ ...healthy, currentPrice: 95, peakPrice: 100 });
  assert.equal(loss.action, 'EXIT');
  const limit = calculateExitScore({ ...healthy, daysHeld: 20 });
  assert.equal(limit.action, 'EXIT');
  const locked = calculateExitScore({ ...healthy, currentPrice: 90, peakPrice: 100, daysHeld: 0 });
  assert.equal(locked.recommendation, 'EXIT');
  assert.equal(locked.action, 'WAIT');
  assert.equal(locked.canSell, false);
  assert.ok(locked.reasons.includes('a-share-t1-locked'));
});

test('missing or inconsistent exit inputs WAIT rather than blind HOLD', () => {
  assert.equal(calculateExitScore().action, 'WAIT');
  for (const field of ['entryPrice', 'currentPrice', 'peakPrice', 'daysHeld', 'trendBreak', 'flowWeakening', 'liquidityStress', 'marketRisk']) {
    const input = { ...healthy };
    delete input[field];
    assert.equal(calculateExitScore(input).action, 'WAIT', field);
  }
  assert.equal(calculateExitScore({ ...healthy, peakPrice: 90 }).action, 'WAIT');
  assert.throws(() => calculateExitScore(healthy, 'normal', { trim: 80, exit: 70 }), TypeError);
});

test('exit history slices at asOf; future crash does not influence past advice', () => {
  const input = {
    position: { ...healthy, entryDate: sessions[0] },
    sessions, asOfDate: sessions[1], market: 'normal',
    bars: [{ date: sessions[0], close: 100 }, { date: sessions[1], close: 102 }]
  };
  const before = evaluateExitAtDate(input);
  const after = evaluateExitAtDate({ ...input, bars: [...input.bars, { date: sessions[2], close: 1 }] });
  assert.deepEqual(after, before);
  assert.equal(after.action, 'HOLD');
  assert.equal(after.daysHeld, 1);
  assert.equal(evaluateExitAtDate({ ...input, asOfDate: sessions[0] }).canSell, false);
  assert.equal(evaluateExitAtDate({ ...input, bars: [] }).action, 'WAIT');
});

test('same input is deterministic and does not mutate input', () => {
  const input = structuredClone(fixture);
  const before = JSON.stringify(input);
  assert.deepEqual(run(input), run(input));
  assert.equal(JSON.stringify(input), before);
});

test('CLI runs end to end and exclusive output does not overwrite prior report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'short-alpha-'));
  const script = fileURLToPath(new URL('../run.js', import.meta.url));
  const input = fileURLToPath(new URL('./fixtures/short_alpha.json', import.meta.url));
  const output = join(directory, 'report.json');
  try {
    const first = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const contents = await readFile(output, 'utf8');
    assert.equal(JSON.parse(contents).version, 'V10.4.1 Short Alpha');
    const second = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.equal(await readFile(output, 'utf8'), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
