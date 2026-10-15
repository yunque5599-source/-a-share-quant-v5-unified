import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canExecuteBuyNow, applyRegimeToCandidate,
  evaluateRegimeExecution
} from '../market_regime_execution.js';
import { benchmarkV12RegimeGate } from '../backtest/v12_regime_backtest.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/v12_oos.json', import.meta.url), 'utf8'
));

test('Bull permits BUY_NOW but never upgrades WAIT_PULLBACK', () => {
  const policy = evaluateRegimeExecution({asOf:'2026-01-01',marketRegime:'bull'});
  assert.equal(policy.action, 'BUY_NOW');
  assert.equal(policy.exposure, 1);
  assert.equal(canExecuteBuyNow(policy, {
    timing:{signal:'BUY_NOW'}
  }), true);
  assert.equal(canExecuteBuyNow(policy, {
    timing:{signal:'WAIT_PULLBACK'}
  }), false);
});

test('Neutral cadence halves exposure and lowers frequency', () => {
  const first = evaluateRegimeExecution(
    {asOf:'2026-01-01',marketRegime:'neutral'}, {neutralOrdinal:0, neutralEvery:2, neutralExposure:0.4}
  );
  const second = evaluateRegimeExecution(
    {asOf:'2026-01-01',marketRegime:'sideways'}, {neutralOrdinal:1, neutralEvery:2, neutralExposure:0.4}
  );
  assert.equal(first.state, 'neutral');
  assert.equal(first.action, 'BUY_NOW');
  assert.equal(first.exposure, 0.4);
  assert.equal(second.action, 'WAIT');
  assert.equal(second.exposure, 0);
  assert.equal(second.frequencyEligible, false);
});

test('Bear and unknown states fail closed to WAIT', () => {
  for (const snapshot of [{marketRegime:'bear'}, {}]) {
    const policy = evaluateRegimeExecution(snapshot);
    assert.equal(policy.action, 'WAIT');
    assert.equal(policy.exposure, 0);
    assert.equal(policy.frequencyEligible, false);
  }
});

test('Regime gate reduces bear loss and transactions without changing V12 rank', () => {
  const before = JSON.stringify(fixture.predictions[6].ranking);
  const result = benchmarkV12RegimeGate(fixture, {
    trainSize:2, testSize:2, step:2,
    neutralEvery:2, neutralExposure:0.5,
    costs:{commissionBps:3,stampTaxBps:5,slippageBps:5}
  });
  assert.equal(result.schema, 'v12-regime-gate-v1');
  assert.equal(result.diagnostics.foldCount, 8);
  assert.equal(JSON.stringify(fixture.predictions[6].ranking), before);
  for (const top of ['top1','top5']) {
    for (const horizon of ['T+1','T+3','T+5']) {
      const baseline = result.aggregate.baseline.bear[top][horizon];
      const gated = result.aggregate.gated.bear[top][horizon];
      assert.ok(baseline.net.cumulativeReturnPct < 0);
      assert.equal(gated.transactionCount, 0);
      assert.equal(gated.net.averageReturnPct, 0);
      assert.equal(gated.net.cumulativeReturnPct, 0);
      assert.equal(gated.net.winRatePct, null);
      assert.equal(gated.net.maxDrawdownPct, 0);
      assert.ok(gated.skippedObservations > 0);
    }
  }
  const baseOverall = result.aggregate.baseline.overall.top1['T+3'];
  const gatedOverall = result.aggregate.gated.overall.top1['T+3'];
  assert.ok(gatedOverall.transactionCount < baseOverall.transactionCount);
  assert.ok(gatedOverall.net.cumulativeReturnPct >
    baseOverall.net.cumulativeReturnPct);
  assert.ok(gatedOverall.net.maxDrawdownPct <
    baseOverall.net.maxDrawdownPct);
  assert.ok(result.aggregate.gated.sideways.top1['T+3'].transactionCount <
    result.aggregate.baseline.sideways.top1['T+3'].transactionCount);
});

test('Regime gate CLI emits comparison document', () => {
  const moduleFile = fileURLToPath(
    new URL('../backtest/v12_regime_backtest.js', import.meta.url)
  );
  const fixtureFile = fileURLToPath(
    new URL('./fixtures/v12_oos.json', import.meta.url)
  );
  const result = spawnSync(process.execPath, [
    moduleFile, '--input', fixtureFile
  ], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schema, 'v12-regime-gate-v1');
  assert.ok(document.aggregate.gated.bear.top1['T+1']);
  assert.deepEqual(document.config.costs,{commissionBps:3,stampTaxBps:5,slippageBps:5});
  assert.equal(document.diagnostics.foldCount,8);
});

test('invalid/future market timestamps fail closed',()=>{for(const s of [{marketRegime:'bull'},{asOf:'2026-01-01',market:{regime:'bull',asOf:'2026-01-02'}}])assert.equal(evaluateRegimeExecution(s).action,'WAIT');});
test('same BUY_NOW eligibility keeps bull arms equal',()=>{const r=benchmarkV12RegimeGate(fixture);for(const top of ['top1','top5'])for(const h of ['T+1','T+3','T+5']){const a=r.aggregate.baseline.bull[top][h],b=r.aggregate.gated.bull[top][h];assert.equal(a.transactionCount,b.transactionCount);assert.equal(a.net.cumulativeReturnPct,b.net.cumulativeReturnPct);assert.equal(a.net.maxDrawdownPct,b.net.maxDrawdownPct);}});
test('cadence persists and missing prices are unavailable',()=>{const a=benchmarkV12RegimeGate(fixture,{testSize:2,step:2}),b=benchmarkV12RegimeGate(fixture,{testSize:1,step:1});assert.deepEqual(a.decisions,b.decisions);assert.equal(a.aggregate.gated.sideways.top5['T+1'].transactionCount,12);const x=structuredClone(fixture);delete x.histories['600001'];assert.equal(benchmarkV12RegimeGate(x).aggregate.baseline.overall.top1['T+1'].net.averageReturnPct,null);});
test('scores stay unchanged and future bars do not gate buys',()=>{const c={rank:2,scores:{alpha:91,timing:85,psychology:70},timing:{signal:'BUY_NOW'}},bars=Array.from({length:21},(_,i)=>({date:'2026-01-'+String(i+1).padStart(2,'0'),close:100+i}),);const s={asOf:'2026-01-21',marketHistory:bars,breadthPct:75},a=applyRegimeToCandidate(s,c),b=applyRegimeToCandidate({...s,marketHistory:[...bars,{date:'2026-01-22',close:1}]},c);assert.deepEqual(a,b);assert.deepEqual(a.scores,c.scores);});
