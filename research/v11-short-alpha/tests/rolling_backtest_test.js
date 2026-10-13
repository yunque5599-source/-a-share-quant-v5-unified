import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rollingBacktest } from '../backtest/rolling_backtest.js';

const fixtureUrl = new URL('./fixtures/rolling_backtest.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const clone = () => structuredClone(fixture);

test('walk-forward folds keep training before future validation', () => {
  const before = JSON.stringify(fixture);
  const result = rollingBacktest(clone());
  assert.equal(result.schema, 'v11-short-alpha-rolling-backtest-v1');
  assert.deepEqual(result.config.horizons, [1, 3, 5]);
  assert.deepEqual(result.config.topNs, [1, 5]);
  assert.equal(result.config.adjustment, 'none');
  assert.equal(result.folds.length, 4);
  for (const fold of result.folds) {
    assert.equal(fold.training.count, 2);
    assert.equal(fold.validation.count, 1);
    assert.ok(fold.training.end < fold.validation.start);
    assert.equal(fold.trainingProfile.adjustment, 'none');
    assert.equal(fold.trainingProfile.weights, 'fixed-v11-alpha-30-25-20-15-10');
  }
  assert.equal(result.diagnostics.validationSnapshotCount, 4);
  assert.equal(JSON.stringify(fixture), before);
});

test('reports Top1 and Top5 out-of-sample metrics for all horizons', () => {
  const result = rollingBacktest(fixture);
  for (const topN of [1, 5]) {
    const key = 'top' + topN;
    for (const horizon of ['T+1', 'T+3', 'T+5']) {
      const metrics = result.aggregate[key][horizon];
      assert.equal(metrics.tradeCount, topN === 1 ? 4 : 20);
      assert.equal(metrics.unavailable, 0);
      assert.equal(typeof metrics.averageReturnPct, 'number');
      assert.equal(typeof metrics.winRatePct, 'number');
      assert.equal(typeof metrics.maxDrawdownPct, 'number');
      assert.ok(metrics.payoffRatio === null || typeof metrics.payoffRatio === 'number');
      assert.ok(result.folds.every(fold => typeof fold.results[key][horizon].tradeCount === 'number'));
    }
  }
});

test('supports different rolling window sizes without leaking partial future windows', () => {
  const result = rollingBacktest(fixture, {trainSize:1, testSize:2, step:2});
  assert.equal(result.config.trainSize, 1);
  assert.equal(result.config.testSize, 2);
  assert.equal(result.folds.length, 2);
  assert.equal(result.folds[0].validation.count, 2);
  assert.equal(result.folds[1].validation.count, 2);
  assert.equal(result.diagnostics.skippedPartialFold, 1);
  const partial = rollingBacktest(fixture, {
    trainSize:1, testSize:2, step:2, includePartial:true
  });
  assert.equal(partial.folds.length, 3);
  assert.equal(partial.folds.at(-1).validation.count, 1);
});

test('invalid and duplicate snapshot dates are diagnosed safely', () => {
  const input = clone();
  input.predictions.push(structuredClone(input.predictions[0]));
  input.predictions.push({asOf:'not-a-date',ranking:[]});
  const result = rollingBacktest(input);
  assert.equal(result.diagnostics.duplicateSnapshotDates, 1);
  assert.equal(result.diagnostics.invalidSnapshotDates, 1);
  assert.equal(result.folds.length, 4);
});

test('CLI emits the rolling validation document', () => {
  const moduleFile = fileURLToPath(new URL('../backtest/rolling_backtest.js', import.meta.url));
  const fixtureFile = fileURLToPath(fixtureUrl);
  const result = spawnSync(process.execPath, [moduleFile, '--input', fixtureFile], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 'V11 Short Alpha Out-of-Sample Rolling Validation');
  assert.deepEqual(Object.keys(document.aggregate), ['top1', 'top5']);
});


test('rolling replay can select by composite timing score explicitly', () => {
  const input = clone();
  for (const snapshot of input.predictions) {
    for (const candidate of snapshot.ranking) {
      const timing = candidate.symbol === '600001' ? 85 : 65;
      candidate.scores.timing = timing;
      candidate.scores.timingRaw = timing;
      candidate.scores.composite = candidate.scores.alpha * 0.7 + timing * 0.3;
      candidate.scores.compositeRaw = candidate.scores.composite;
    }
  }
  const result = rollingBacktest(input, {selectionScore:'composite'});
  assert.equal(result.config.selectionScore, 'composite');
  assert.equal(result.folds[0].trainingProfile.selectionScore, 'composite');
  assert.equal(result.folds[0].trainingProfile.timingVersion, 'V11 Buy Timing Phase 1');
  assert.equal(result.aggregate.top1['T+1'].tradeCount, 4);
});
