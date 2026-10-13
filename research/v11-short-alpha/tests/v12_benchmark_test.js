import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { benchmarkV12 } from '../backtest/v12_benchmark.js';
import { computeV12TradeScore } from '../v12_trade_score.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/v12_benchmark.json', import.meta.url), 'utf8'
));

test('V12 formula is Alpha60 Timing25 Psychology15 and requires psychology', () => {
  const score = computeV12TradeScore({scores:{alphaRaw:90,timingRaw:80,psychologyRaw:100}});
  assert.equal(score.score, 89);
  assert.equal(computeV12TradeScore({scores:{alphaRaw:90,timingRaw:80}}), null);
});

test('compares Composite and V12 across periods and all horizons', () => {
  const result = benchmarkV12(fixture);
  assert.deepEqual(result.config.strategies, ['composite','v12']);
  assert.equal(result.periods.length, 3);
  for (const strategy of result.config.strategies) {
    for (const topN of [1,5]) {
      for (const horizon of ['T+1','T+3','T+5']) {
        const metrics = result.aggregate[strategy]['top' + topN][horizon];
        assert.equal(metrics.tradeCount, topN === 1 ? 18 : 90);
        assert.equal(typeof metrics.averageReturnPct, 'number');
        assert.equal(typeof metrics.winRatePct, 'number');
        assert.equal(typeof metrics.maxDrawdownPct, 'number');
        assert.ok(metrics.payoffRatio === null ||
          typeof metrics.payoffRatio === 'number');
        assert.ok(metrics.buyNowAccuracyPct === null ||
          typeof metrics.buyNowAccuracyPct === 'number');
      }
    }
  }
});

test('V12 improves the synthetic sample over Composite', () => {
  const result = benchmarkV12(fixture);
  for (const horizon of ['T+1','T+3','T+5']) {
    const composite = result.aggregate.composite.top1[horizon];
    const v12 = result.aggregate.v12.top1[horizon];
    assert.ok(v12.averageReturnPct > composite.averageReturnPct);
    assert.ok(v12.winRatePct >= composite.winRatePct);
    assert.ok((v12.buyNowAccuracyPct ?? 0) >=
      (composite.buyNowAccuracyPct ?? 0));
  }
});

test('CLI emits V12 benchmark metrics', () => {
  const moduleFile = fileURLToPath(new URL('../backtest/v12_benchmark.js', import.meta.url));
  const fixtureFile = fileURLToPath(new URL('./fixtures/v12_benchmark.json', import.meta.url));
  const result = spawnSync(process.execPath, [moduleFile, '--input', fixtureFile], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schema, 'v12-trade-score-benchmark-v1');
  assert.ok(document.aggregate.v12.top5['T+5'].sampleCount > 0);
});
