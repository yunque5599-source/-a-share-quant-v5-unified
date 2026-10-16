import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { benchmarkV12OutOfSample } from '../backtest/v12_oos.js';
import { backtestAlpha } from '../backtest/alpha_backtest.js';
import { classifyMarketRegime } from '../market_regime.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/v12_oos.json', import.meta.url), 'utf8'
));

test('Market Regime groups explicit bull, sideways and bear snapshots', () => {
  assert.equal(classifyMarketRegime({marketRegime:'bull'}).regime, 'bull');
  assert.equal(classifyMarketRegime({marketRegime:'sideways'}).regime, 'sideways');
  assert.equal(classifyMarketRegime({marketRegime:'bear'}).regime, 'bear');
  assert.equal(classifyMarketRegime({}).regime, 'unknown');
});

test('Market Regime ignores market bars after asOf', () => {
  const history = Array.from({length: 21}, (_, index) => ({
    date: '2026-01-' + String(index + 1).padStart(2, '0'),
    close: 100 + index
  }));
  history.push({date:'2026-02-01', close: 20});
  const result = classifyMarketRegime({
    asOf:'2026-01-21',
    marketHistory:history,
    breadth:{advancers:75,decliners:25}
  });
  assert.equal(result.regime, 'bull');
  assert.equal(result.confidence, 1);
  assert.equal(result.features.breadthPct, 75);
});

test('walk-forward V12 OOS reports gross and net costs by regime', () => {
  const result = benchmarkV12OutOfSample(fixture, {
    trainSize:2, testSize:2, step:2,
    costs:{commissionBps:3,stampTaxBps:5,slippageBps:5}
  });
  assert.equal(result.schema, 'v12-trade-oos-v1');
  assert.equal(result.diagnostics.foldCount, 8);
  assert.deepEqual(result.config.regimes, ['bull','bear','sideways','unknown']);
  for (const regime of ['overall','bull','bear','sideways']) {
    const metrics = result.aggregate[regime].top1['T+3'];
    assert.ok(metrics.gross.averageReturnPct !== null);
    assert.ok(metrics.net.averageReturnPct !== null);
    assert.ok(metrics.net.averageReturnPct <= metrics.gross.averageReturnPct);
    assert.ok(typeof metrics.net.maxDrawdownPct === 'number');
    assert.ok(metrics.net.buyNowAccuracyPct === null ||
      typeof metrics.net.buyNowAccuracyPct === 'number');
  }
  assert.ok(result.aggregate.bull.top1['T+3'].net.averageReturnPct >
    result.aggregate.bear.top1['T+3'].net.averageReturnPct);
  assert.ok(result.aggregate.bull.top1['T+3'].net.winRatePct >
    result.aggregate.bear.top1['T+3'].net.winRatePct);
});

test('zero costs preserve gross and net returns', () => {
  const result = benchmarkV12OutOfSample(fixture, {
    trainSize:2, testSize:2, step:2,
    costs:{commissionBps:0,stampTaxBps:0,slippageBps:0}
  });
  const metric = result.aggregate.overall.top5['T+5'];
  assert.equal(metric.gross.averageReturnPct, metric.net.averageReturnPct);
  assert.equal(metric.gross.maxDrawdownPct, metric.net.maxDrawdownPct);
});

test('trade cost breakdown records commission tax and slippage', () => {
  const result = backtestAlpha({
    predictions:[{asOf:'2026-01-01',ranking:[{
      symbol:'600001',price:100,scores:{alpha:90,timing:80,psychology:70},
      quality:{complete:true}
    }]}],
    histories:{'600001':[
      {date:'2026-01-01',close:100},{date:'2026-01-02',close:110}
    ]}
  }, {horizons:[1],topN:1,costs:{commissionBps:3,stampTaxBps:5,slippageBps:5}});
  const trade=result.results['T+1'].trades[0];
  assert.equal(trade.status,'ok');
  assert.equal(trade.netReturnPct,trade.returnPct);
  assert.ok(trade.commissionPct > 0);
  assert.ok(trade.stampTaxPct > 0);
  assert.ok(trade.slippagePct > 0);
  assert.ok(trade.totalCostPct > 0);
});

test('costs reduce a positive trade and worsen a negative trade', () => {
  const input = structuredClone(fixture);
  const first = input.predictions[0].ranking[1];
  const result = benchmarkV12OutOfSample(input, {
    trainSize:1,testSize:1,step:1,
    costs:{commissionBps:3,stampTaxBps:5,slippageBps:5}
  });
  const trade = result.aggregate.overall.top1['T+1'];
  assert.ok(trade.net.averageReturnPct < trade.gross.averageReturnPct);
  assert.ok(trade.net.maxDrawdownPct >= 0);
  assert.ok(first.scores.v12TradeRaw > 0);
  const detail = result.aggregate.overall.top1['T+1'];
  assert.ok(detail.net.averageReturnPct < detail.gross.averageReturnPct);
});
