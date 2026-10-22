import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidateOutcome, evaluateWalkForward } from '../research/v13-limitup-precursor/walk_forward_eval.js';

function makeHistory(code, name, slope, industry = 'TestIndustry') {
  const bars = [];
  let close = 10;
  for (let i = 0; i < 45; i++) {
    if (i < 40) close = 10 + slope * i;
    else close = bars.at(-1).close * 1.002;
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
  const flows = bars.map((bar, i) => ({
    date: bar.date,
    mainNet: slope > 0 ? (i + 1) * 100000 : -100000,
    mainPct: slope > 0 ? 1.5 : -1,
    amount: bar.amount
  }));
  return { code, name, industry, isST: false, bars, flows };
}

test('forward outcome labels are computed from bars strictly after the signal date', () => {
  const stock = makeHistory('300006', '样本创业板', 0.02);
  const signalDate = stock.bars[39].date;
  const prior = stock.bars[39].close;
  stock.bars[40].open = prior;
  stock.bars[40].close = prior * 1.20;
  stock.bars[40].high = prior * 1.21;
  stock.bars[40].low = prior * 0.99;
  const outcome = evaluateCandidateOutcome(stock, signalDate);
  assert.ok(Math.abs(outcome.t1CloseReturnPct - 20) < 1e-9);
  assert.equal(outcome.limitUpWithin1, true);
  assert.equal(outcome.futureBarsAvailable, 5);
});

test('walk-forward ranking does not change when only future outcome bars change', () => {
  const original = [
    makeHistory('300006', '样本A', 0.025, '行业A'),
    makeHistory('600001', '样本B', -0.015, '行业A'),
    makeHistory('000001', '样本C', 0.01, '行业B')
  ];
  const signalDate = original[0].bars[39].date;
  const first = evaluateWalkForward(original, { signalDays: 1, sourceCoveragePct: 100 });
  const altered = original.map(stock => ({
    ...stock,
    bars: stock.bars.map(bar => ({ ...bar }))
  }));
  const changed = altered.find(stock => stock.code === '300006');
  const priorClose = changed.bars[39].close;
  changed.bars[40].close = priorClose * 1.20;
  changed.bars[40].high = priorClose * 1.22;
  changed.bars[40].low = priorClose * 0.98;
  const second = evaluateWalkForward(altered, { signalDays: 1, sourceCoveragePct: 100 });
  assert.equal(first.signalDates[0], signalDate);
  assert.deepEqual(first.perDate[0].modelTop10Codes, second.perDate[0].modelTop10Codes);
  assert.deepEqual(first.perDate[0].momentumTop10Codes, second.perDate[0].momentumTop10Codes);
  assert.equal(first.status, 'NOT_MEASURABLE');
  assert.ok(first.reasons.includes('fewer-than-three-complete-forward-evaluation-dates'));
});

test('walk-forward report is not measurable when source universe coverage is below 90 percent', () => {
  const candidates = [
    makeHistory('300006', '样本A', 0.02),
    makeHistory('600001', '样本B', -0.01)
  ];
  const report = evaluateWalkForward(candidates, { signalDays: 5, sourceCoveragePct: 79.55 });
  assert.equal(report.status, 'NOT_MEASURABLE');
  assert.ok(report.reasons.includes('historical-bar-coverage-below-90pct'));
});


test('walk-forward evaluation becomes measurable with sufficient dates and complete outcomes', () => {
  const candidates = [
    makeHistory('300006', '样本A', 0.02, '行业A'),
    makeHistory('600001', '样本B', -0.01, '行业A'),
    makeHistory('000001', '样本C', 0.01, '行业B')
  ];
  const report = evaluateWalkForward(candidates, { signalDays: 5, sourceCoveragePct: 100 });
  assert.equal(report.status, 'MEASURABLE');
  assert.equal(report.signalDateCount, 5);
  assert.equal(report.minimumT5OutcomeCoveragePct, 100);
  assert.ok(report.summary.top10.model.t5.meanCloseReturnPct !== null);
  assert.ok(report.summary.top10.v12EarlyOpportunity.t5.meanCloseReturnPct !== null);
  assert.ok(report.summary.top10.momentumBaseline.t5.meanCloseReturnPct !== null);
});
