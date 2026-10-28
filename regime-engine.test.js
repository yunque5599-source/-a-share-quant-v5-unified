import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveScore, classifyMarketRegime, sizePosition, REGIME_POLICIES } from './regime-engine.js';

const pctRows = (n, up, strong = 0.2, down = 0.1) => Array.from({ length: n }, (_, i) => ({
  pct: i < Math.round(n * up) ? (i < Math.round(n * strong) ? 4 : 0.8) : i >= n - Math.round(n * down) ? -4 : -0.5
}));
const indexes = ({ daily = 0, r5 = 0, r20 = 0, dd = -0.02, atr = 0.02 } = {}) => [
  { name: '上证', dailyReturn: daily, ret5: r5, ret20: r20, drawdown20: dd, atrPct: atr },
  { name: '深证', dailyReturn: daily, ret5: r5, ret20: r20, drawdown20: dd, atrPct: atr },
  { name: '创业板', dailyReturn: daily, ret5: r5, ret20: r20, drawdown20: dd, atrPct: atr },
  { name: '科创50', dailyReturn: daily, ret5: r5, ret20: r20, drawdown20: dd, atrPct: atr }
];

test('classifies a broad, sustained advance as bull trend', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: 0.008, r5: 0.04, r20: 0.08, dd: -0.01 }), fullUniverse: pctRows(1000, 0.68, 0.22, 0.05) });
  assert.equal(r.state, 'BULL_TREND');
  assert.equal(r.allowNewPositions, true);
  assert.ok(r.maxPos > 0.25);
  assert.equal(r.dataQuality, 'BROAD_UNIVERSE');
});

test('classifies persistent decline as bear trend and tightens risk', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: -0.014, r5: -0.05, r20: -0.10, dd: -0.16 }), fullUniverse: pctRows(1000, 0.25, 0.04, 0.55) });
  assert.equal(r.state, 'BEAR_TREND');
  assert.equal(r.maxPos, 0.12);
  assert.ok(r.riskPerTrade < 0.01);
  assert.equal(r.maxHoldingDays, 3);
});

test('locks new entries in extreme risk', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ pct: i < 100 ? 1 : i < 800 ? -4 : -8 }));
  const r = classifyMarketRegime({ indices: indexes({ daily: -0.03, r5: -0.08, r20: -0.14, dd: -0.20, atr: 0.08 }), fullUniverse: rows });
  assert.equal(r.state, 'EXTREME_RISK');
  assert.equal(r.allowNewPositions, false);
  assert.equal(sizePosition({ price: 10, atrPct: 0.03, score: 99, capital: 27000 }, r).reason, 'market-risk-lock');
});

test('detects recovery after a weak medium-term trend', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: 0.006, r5: 0.035, r20: -0.02, dd: -0.08 }), fullUniverse: pctRows(1000, 0.62, 0.18, 0.08) });
  assert.equal(r.state, 'RECOVERY');
  assert.ok(r.maxPos < 0.25);
  assert.ok(r.minScore > 74);
});

test('falls back transparently to candidate-pool proxy and caps risk', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: 0.001 }), candidates: pctRows(120, 0.55, 0.12, 0.12) });
  assert.equal(r.breadthSource, 'ranked-candidate-proxy');
  assert.equal(r.dataQuality, 'CANDIDATE_PROXY');
  assert.ok(r.maxPos <= 0.75 * 0.35);
  assert.ok(r.evidence.some(x => x.includes('候选池代理')));
});

test('adaptive score uses regime weights and penalties', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: 0.001 }), candidates: pctRows(120, 0.55) });
  const score = adaptiveScore({ T: 80, F: 70, M: 60, E: 90, P: 80, N: 50, C: 2, X: 1, Y: 1 }, r);
  assert.ok(score >= 0 && score <= 100);
  assert.ok(score < 80);
});

test('position sizing respects risk, lot size and cash', () => {
  const r = classifyMarketRegime({ indices: indexes({ daily: 0.008, r5: 0.04, r20: 0.08 }), fullUniverse: pctRows(1000, 0.68, 0.22, 0.05) });
  const p = sizePosition({ price: 10, atrPct: 0.03, score: 88, capital: 27000, availableCash: 3000 }, r);
  assert.ok(p.shares % 100 === 0);
  assert.ok(p.notional <= 2990);
  assert.ok(p.riskPct <= r.riskPerTrade + 1e-9);
});

test('every regime policy has normalized scoring weights and bounded risk', () => {
  for (const [state, p] of Object.entries(REGIME_POLICIES)) {
    const scoreWeightSum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    const stageWeightSum = Object.values(p.stage1Weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(scoreWeightSum - 1) < 1e-9, state + ' score weights');
    assert.ok(Math.abs(stageWeightSum - 1) < 1e-9, state + ' stage weights');
    assert.ok(p.maxPos >= 0 && p.maxPos <= 0.35, state + ' position cap');
    assert.ok(p.riskPerTrade >= 0 && p.riskPerTrade <= 0.018, state + ' risk budget');
  }
});
