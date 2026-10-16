import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { backtestAlpha } from '../backtest/alpha_backtest.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/timing_backtest.json', import.meta.url), 'utf8'
));

test('selectionScore alpha and composite choose different Top1 candidates', () => {
  const alpha = backtestAlpha(fixture, {topN:1,selectionScore:'alpha'});
  const composite = backtestAlpha(fixture, {topN:1,selectionScore:'composite'});
  assert.equal(alpha.options.selectionScore, 'alpha');
  assert.equal(composite.options.selectionScore, 'composite');
  for (const horizon of ['T+1','T+3','T+5']) {
    const alphaTrade = alpha.results[horizon].trades.find(trade => trade.status === 'ok');
    const compositeTrade = composite.results[horizon].trades.find(trade => trade.status === 'ok');
    assert.equal(alphaTrade.symbol, '600001');
    assert.equal(compositeTrade.symbol, '600002');
    assert.equal(alphaTrade.selectedBy, 'alpha');
    assert.equal(compositeTrade.selectedBy, 'composite');
    assert.equal(alphaTrade.timingScore, 20);
    assert.equal(compositeTrade.timingScore, 90);
    assert.ok(composite.results[horizon].averageReturnPct >
      alpha.results[horizon].averageReturnPct);
  }
  assert.equal(alpha.results['T+1'].averageReturnPct, -6);
  assert.equal(composite.results['T+1'].averageReturnPct, 3);
  assert.equal(alpha.results['T+3'].averageReturnPct, -10);
  assert.equal(composite.results['T+3'].averageReturnPct, 5);
  assert.equal(alpha.results['T+5'].averageReturnPct, -8);
  assert.equal(composite.results['T+5'].averageReturnPct, 8);
});

test('missing composite score is unavailable rather than Alpha fallback', () => {
  const input = structuredClone(fixture);
  delete input.predictions[0].ranking[1].scores.compositeRaw;
  delete input.predictions[0].ranking[1].scores.composite;
  const result = backtestAlpha(input, {topN:2,selectionScore:'composite',horizons:[1]});
  const missing = result.results['T+1'].trades.find(trade => trade.symbol === '600002');
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'missing-composite-score');
});
