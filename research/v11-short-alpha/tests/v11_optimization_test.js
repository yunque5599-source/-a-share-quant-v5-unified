import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { backtestAlpha } from '../backtest/alpha_backtest.js';
import { integrateCandidateFlow } from '../candidate_flow.js';

const flowFixtureUrl = new URL('./fixtures/v11_flow.json', import.meta.url);
const flowFixture = JSON.parse(await readFile(flowFixtureUrl, 'utf8'));
const clone = value => structuredClone(value);
const first = result => result.ranking.find(candidate => candidate.symbol === '600001');

function highRiskFlowInput() {
  const input = clone(flowFixture);
  const item = input.deep.items.find(candidate => candidate.code === '600001');
  const kline = item.kline.data.klines.map(row => row.split(','));
  kline.forEach((fields, index) => {
    if (index < 20) {
      fields[2] = '100';
      fields[3] = '101';
      fields[4] = '99';
    } else {
      const close = 100 + (index - 19) * 10;
      fields[2] = String(close);
      fields[3] = String(close + 1);
      fields[4] = String(close - 1);
    }
  });
  item.kline.data.klines = kline.map(fields => fields.join(','));
  const flows = item.flow.data.klines.map((row, index) => {
    const fields = row.split(',');
    fields[1] = index < 20 ? '-10000000' : '100000000';
    fields[6] = index < 20 ? '-1' : '12';
    return fields.join(',');
  });
  item.flow.data.klines = flows;
  return input;
}

test('identifies startup/acceleration and high-risk trend phases', () => {
  const baseline = first(integrateCandidateFlow(flowFixture));
  const highRisk = first(integrateCandidateFlow(highRiskFlowInput()));
  assert.ok(['startup', 'acceleration', 'mature'].includes(baseline.features.momentum.trendStage));
  assert.equal(highRisk.features.momentum.trendStage, 'high-risk');
  assert.equal(highRisk.features.momentum.overboughtRisk, 'high');
  assert.ok(highRisk.features.momentum.overboughtPenalty > 0);
  assert.ok(highRisk.features.momentum.score < baseline.features.momentum.score);
  assert.ok(highRisk.reasons.includes('overbought-risk-high'));
  assert.ok(highRisk.reasons.includes('trend-high-risk'));
});

test('distinguishes early capital from high-position late inflow', () => {
  const baseline = first(integrateCandidateFlow(flowFixture));
  const highRisk = first(integrateCandidateFlow(highRiskFlowInput()));
  assert.equal(baseline.features.capital.flowTiming, 'early-inflow');
  assert.ok(baseline.features.capital.earlyNetCny > 0);
  assert.equal(highRisk.features.capital.flowTiming, 'late-high-inflow');
  assert.ok(highRisk.features.capital.earlyNetCny < 0);
  assert.ok(highRisk.features.capital.recentNetCny > 0);
  assert.ok(highRisk.features.capital.lateFlowPenalty > 0);
  assert.ok(highRisk.features.capital.score < baseline.features.capital.score);
  assert.ok(highRisk.reasons.includes('capital-late-high-inflow'));
});

test('optimized ranking improves the same-sample T+1 and T+3 replay', () => {
  const histories = {
    '600001': [
      {date:'2026-05-04',close:100},{date:'2026-05-05',close:94},
      {date:'2026-05-06',close:93},{date:'2026-05-07',close:90},
      {date:'2026-05-08',close:94},{date:'2026-05-11',close:92}
    ],
    '600002': [
      {date:'2026-05-04',close:100},{date:'2026-05-05',close:103},
      {date:'2026-05-06',close:104},{date:'2026-05-07',close:105},
      {date:'2026-05-08',close:106},{date:'2026-05-11',close:108}
    ]
  };
  const ranking = (highFirst, highScore) => ({
    asOf:'2026-05-04',
    ranking: highFirst ? [
      {symbol:'600001',rank:1,price:100,scores:{alpha:highScore},quality:{complete:true}},
      {symbol:'600002',rank:2,price:100,scores:{alpha:85},quality:{complete:true}}
    ] : [
      {symbol:'600002',rank:1,price:100,scores:{alpha:85},quality:{complete:true}},
      {symbol:'600001',rank:2,price:100,scores:{alpha:highScore},quality:{complete:true}}
    ]
  });
  const oldResult = backtestAlpha({predictions:[ranking(true,92)],histories}, {topN:1});
  const optimizedResult = backtestAlpha({predictions:[ranking(false,70)],histories}, {topN:1});
  for (const horizon of ['T+1','T+3','T+5']) {
    assert.ok(optimizedResult.results[horizon].averageReturnPct >
      oldResult.results[horizon].averageReturnPct);
    assert.ok(optimizedResult.results[horizon].winRatePct >=
      oldResult.results[horizon].winRatePct);
  }
  assert.equal(oldResult.results['T+1'].averageReturnPct, -6);
  assert.equal(optimizedResult.results['T+1'].averageReturnPct, 3);
  assert.equal(oldResult.results['T+3'].averageReturnPct, -10);
  assert.equal(optimizedResult.results['T+3'].averageReturnPct, 5);
  assert.equal(oldResult.results['T+5'].averageReturnPct, -8);
  assert.equal(optimizedResult.results['T+5'].averageReturnPct, 8);
});
