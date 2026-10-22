'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { boardForCode, scoreCandidate, rankCandidates } from '../research/v13-limitup-precursor/precursor_score.js';

function makeCandidate({ code = '600001', name = '样本股', strong = true, pct = 4.2, future = false } = {}) {
  const bars = [];
  for (let i = 0; i < 34; i++) {
    let close;
    if (strong) {
      if (i < 22) close = 10.2 - i * 0.018;
      else if (i < 29) close = 9.78 + (i - 22) * 0.006;
      else close = [9.83, 9.86, 9.91, 9.98, 10.02, 10.06, 10.08, 10.10, 10.10, 10.10, 10.10, 10.10][i - 29] || 10.10;
    } else {
      close = 10.4 - i * 0.027;
    }
    if (i === 33) close = bars[bars.length - 1].close * (1 + pct / 100);
    const prev = bars.length ? bars[bars.length - 1].close : close;
    const day = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    const volume = strong ? (i === 33 ? 260 : i >= 28 ? 80 : 100) : 65;
    bars.push({
      date: day, open: prev * 0.998,
      high: Math.max(prev, close) * (i === 33 ? 1.012 : 1.006),
      low: Math.min(prev, close) * 0.994, close, volume,
      amount: strong ? 120000000 : 45000000, turnoverRate: strong ? 6.8 : 1.2
    });
  }
  const flows = bars.slice(-7).map((bar, i) => ({
    date: bar.date, mainNet: strong ? (i + 1) * 2000000 : -1500000,
    mainPct: strong ? 2.4 : -1.2, amount: bar.amount
  }));
  const sector = strong
    ? { return3Pct: 3.2, return5Pct: 5.8, upRatio: 0.72, limitUpCount: 3, leaderScore: 76, catalystScore: 72, themeHeat: 68 }
    : { return3Pct: -1.4, return5Pct: -3.2, upRatio: 0.31, limitUpCount: 0, leaderScore: 38, catalystScore: 42, themeHeat: 35 };
  if (future) {
    bars.push({ date: '2026-10-01', open: 11.2, high: 12.2, low: 11.1, close: 12.0, volume: 1000, amount: 900000000, turnoverRate: 22 });
    flows.push({ date: '2026-10-01', mainNet: 500000000, mainPct: 30, amount: 900000000 });
  }
  return { code, name, bars, flows, sector };
}

test('board classification keeps ChiNext names in research universe but separates execution eligibility', () => {
  assert.equal(boardForCode('301159'), 'CHINEXT');
  assert.equal(boardForCode('300006'), 'CHINEXT');
  assert.equal(boardForCode('600707'), 'SH_MAIN');
  assert.equal(boardForCode('920025'), 'BSE');
  const result = scoreCandidate(makeCandidate({ code: '301159', name: '三维天地' }));
  assert.ok(result);
  assert.equal(result.discoveryEligible, true);
  assert.equal(result.executionEligible, false);
  assert.match(result.tradeabilityReason, /BOARD_OR_ACCOUNT_PERMISSION/);
});

test('early-turning / expanding-volume candidate ranks above a weak downtrend', () => {
  const strong = makeCandidate({ code: '301159', name: '三维天地', strong: true });
  const weak = makeCandidate({ code: '600002', name: '弱势样本', strong: false, pct: -1.0 });
  const ranked = rankCandidates([weak, strong]);
  assert.equal(ranked[0].code, '301159');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].components.volumePrice > ranked[1].components.volumePrice);
});

test('a near-limit-up daily move is penalized softly, not hard-filtered', () => {
  const result = scoreCandidate(makeCandidate({ code: '600003', pct: 9.6 }));
  assert.ok(result);
  assert.equal(result.discoveryEligible, true);
  assert.ok(result.riskPenalty > 0);
  assert.ok(result.score >= 0);
});

test('asOf cutoff excludes future bars and future fund-flow records', () => {
  const plain = makeCandidate({ code: '301102', name: '兆讯传媒', future: false });
  const withFuture = makeCandidate({ code: '301102', name: '兆讯传媒', future: true });
  const a = scoreCandidate(plain, { asOf: '2026-09-03' });
  const b = scoreCandidate(withFuture, { asOf: '2026-09-03' });
  assert.ok(a && b);
  assert.equal(a.score, b.score);
  assert.equal(a.asOf, b.asOf);
});

test('missing sector or flow data degrades confidence but does not crash discovery', () => {
  const candidate = makeCandidate({ code: '300006', name: '莱美药业' });
  candidate.flows = [];
  candidate.sector = {};
  const result = scoreCandidate(candidate);
  assert.ok(result);
  assert.equal(result.discoveryEligible, true);
  assert.ok(result.confidence < 75);
  assert.ok(result.riskFlags.some(flag => flag.includes('资金流历史不足')));
});

test('ST and delisting-risk symbols are excluded from discovery', () => {
  const result = scoreCandidate({ ...makeCandidate({ code: '600004' }), name: '*ST风险' });
  assert.equal(result.discoveryEligible, false);
  assert.equal(result.tradeabilityReason, 'ST_OR_DELISTING');
  assert.equal(rankCandidates([{ ...makeCandidate({ code: '600004' }), name: '*ST风险' }]).length, 0);
});

test('score output exposes a 1–5 day horizon and a component audit trail', () => {
  const result = scoreCandidate(makeCandidate({ code: '301486', name: '致尚科技' }));
  assert.deepEqual(result.horizonTradingDays, [1, 5]);
  for (const key of ['trend', 'volumePrice', 'flow', 'sector', 'momentum', 'base']) {
    assert.ok(Number.isFinite(result.components[key]));
    assert.ok(result.components[key] >= 0 && result.components[key] <= 100);
  }
});


test('a sharp flush after a recent limit-up is surfaced through the separate emotion-repair lane', () => {
  const candidate = makeCandidate({ code: '300006', name: '莱美药业', strong: true, pct: -15.49 });
  const priorLimitBar = candidate.bars[31];
  const priorBar = candidate.bars[30];
  priorLimitBar.close = priorBar.close * 1.20;
  priorLimitBar.open = priorBar.close * 1.01;
  priorLimitBar.high = priorLimitBar.close * 1.01;
  priorLimitBar.low = priorBar.close * 0.99;
  const result = scoreCandidate(candidate);
  assert.ok(result);
  assert.ok(result.features.recentLimitUp10Count >= 1);
  assert.equal(result.scorePath, 'emotion-repair');
  assert.equal(result.setup, '情绪反核观察');
  assert.ok(result.components.emotionRepair >= 75);
});
