import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { benchmarkStability } from '../backtest/stability_benchmark.js';

const fixtureUrl = new URL('./fixtures/stability_benchmark.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const clone = () => structuredClone(fixture);

test('benchmarks random, Alpha and composite across expanded periods', () => {
  const before = JSON.stringify(fixture);
  const result = benchmarkStability(clone());
  assert.equal(result.schema, 'v11-short-alpha-stability-benchmark-v1');
  assert.deepEqual(result.config.strategies, ['random','alpha','composite']);
  assert.deepEqual(result.config.horizons, [1,3,5]);
  assert.deepEqual(result.config.topNs, [1,5]);
  assert.equal(result.periods.length, 4);
  for (const period of result.periods) {
    assert.equal(period.range.snapshotCount, 6);
    assert.deepEqual(period.commonUniverse, {random:60,alpha:60,composite:60});
    for (const strategy of result.config.strategies) {
      for (const topN of [1,5]) {
        for (const horizon of ['T+1','T+3','T+5']) {
          const metrics = period.strategies[strategy]['top' + topN][horizon];
          assert.equal(metrics.tradeCount, topN === 1 ? 6 : 30);
          assert.equal(metrics.unavailable, 0);
          assert.equal(typeof metrics.averageReturnPct, 'number');
          assert.equal(typeof metrics.winRatePct, 'number');
          assert.equal(typeof metrics.maxDrawdownPct, 'number');
          assert.ok(metrics.payoffRatio === null || typeof metrics.payoffRatio === 'number');
        }
      }
    }
  }
  for (const strategy of result.config.strategies) {
    assert.equal(result.aggregate[strategy].top1['T+1'].tradeCount, 24);
    assert.equal(result.aggregate[strategy].top5['T+5'].tradeCount, 120);
  }
  assert.equal(JSON.stringify(fixture), before);
});

test('seeded random baseline is reproducible and uses the same universe', () => {
  const one = benchmarkStability(fixture, {seed:'same-seed'});
  const two = benchmarkStability(fixture, {seed:'same-seed'});
  assert.deepEqual(one.aggregate.random, two.aggregate.random);
  assert.equal(one.config.seed, 'same-seed');
  assert.equal(one.periods[0].commonUniverse.random, one.periods[0].commonUniverse.alpha);
});

test('composite improves the expanded fixture over Alpha at short horizons', () => {
  const result = benchmarkStability(fixture);
  for (const horizon of ['T+1','T+3']) {
    const alpha = result.aggregate.alpha.top1[horizon];
    const composite = result.aggregate.composite.top1[horizon];
    assert.ok(composite.averageReturnPct > alpha.averageReturnPct);
    assert.ok(composite.winRatePct >= alpha.winRatePct);
  }
});

test('CLI emits period and strategy metrics', () => {
  const moduleFile = fileURLToPath(new URL('../backtest/stability_benchmark.js', import.meta.url));
  const fixtureFile = fileURLToPath(fixtureUrl);
  const result = spawnSync(process.execPath, [moduleFile, '--input', fixtureFile], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 'V11 Short Alpha Composite Stability Benchmark');
  assert.deepEqual(Object.keys(document.aggregate), ['random','alpha','composite']);
  assert.equal(document.periods.length, 4);
});


test('random baseline is invariant to source ranking order', () => {
  const input = clone();
  for (const snapshot of input.predictions) snapshot.ranking.reverse();
  const original = benchmarkStability(fixture, {seed:'order-seed'});
  const reversed = benchmarkStability(input, {seed:'order-seed'});
  assert.deepEqual(reversed.aggregate.random, original.aggregate.random);
});
