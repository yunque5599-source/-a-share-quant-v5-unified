import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHoldoutAudit } from '../research/v13-limitup-precursor/holdout_audit.js';

function makeHistory(code, name, slope, industry = 'TestIndustry') {
  const bars = [];
  for (let i = 0; i < 45; i++) {
    const close = i < 40
      ? 10 + slope * i
      : bars.at(-1).close * 1.002;
    const previous = bars.length ? bars.at(-1).close : close;
    bars.push({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: previous,
      high: Math.max(previous, close) * 1.01,
      low: Math.min(previous, close) * 0.99,
      close,
      volume: i < 35 ? 100 : 160,
      amount: 120000000,
      turnoverRate: 5
    });
  }
  return {
    code, name, industry, isST: false, bars,
    flows: bars.map((bar, i) => ({
      date: bar.date,
      mainNet: slope > 0 ? (i + 1) * 100000 : -100000,
      mainPct: slope > 0 ? 1.5 : -1,
      amount: bar.amount
    }))
  };
}

test('holdout audit ranks all variants before reading target outcomes and excludes non-limit-up comparison', () => {
  const candidates = [
    makeHistory('300006', '样本A', 0.02, '行业A'),
    makeHistory('600001', '样本B', -0.01, '行业A'),
    makeHistory('000001', '样本C', 0.01, '行业B')
  ];
  const asOf = candidates[0].bars[39].date;
  const targets = [
    { code: '300006', name: '样本A', signalDate: asOf, outcome: 'limit_up_20.00_percent' },
    { code: '000001', name: '样本C', signalDate: asOf, outcome: 'large_gain_17.12_percent_not_closed_limit_up' }
  ];
  const report = evaluateHoldoutAudit(candidates, { asOf, targets, sourceCoveragePct: 100 });
  assert.equal(report.status, 'MEASURABLE');
  assert.equal(report.variants.current.trueLimitUpTargetCount, 1);
  assert.equal(report.variants.coreOnly.trueLimitUpTargetCount, 1);
  assert.equal(report.variants.earlyTurn.trueLimitUpTargetCount, 1);
  assert.ok(Number.isFinite(report.variants.earlyTurn.targets[0].score));
});

test('holdout rank and score do not change when only post-cutoff bars change', () => {
  const candidates = [
    makeHistory('300006', '样本A', 0.02, '行业A'),
    makeHistory('600001', '样本B', -0.01, '行业A'),
    makeHistory('000001', '样本C', 0.01, '行业B')
  ];
  const asOf = candidates[0].bars[39].date;
  const targets = [{ code: '300006', name: '样本A', signalDate: asOf, outcome: 'limit_up_20.00_percent' }];
  const first = evaluateHoldoutAudit(candidates, { asOf, targets, sourceCoveragePct: 100 });
  const altered = candidates.map(stock => ({ ...stock, bars: stock.bars.map(bar => ({ ...bar })) }));
  const target = altered.find(stock => stock.code === '300006');
  const priorClose = target.bars[39].close;
  target.bars[40].close = priorClose * 1.20;
  target.bars[40].high = priorClose * 1.22;
  target.bars[40].low = priorClose * 0.98;
  const second = evaluateHoldoutAudit(altered, { asOf, targets, sourceCoveragePct: 100 });
  for (const variant of ['current', 'coreOnly', 'earlyTurn']) {
    assert.equal(first.variants[variant].targets[0].rank, second.variants[variant].targets[0].rank);
    assert.equal(first.variants[variant].targets[0].score, second.variants[variant].targets[0].score);
  }
});
