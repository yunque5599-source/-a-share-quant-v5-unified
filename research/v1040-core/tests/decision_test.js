import assert from 'node:assert/strict';
import { normalizeCandidates } from '../adapter/candidate_adapter.js';
import { normalizeMarketRisk } from '../adapter/market_adapter.js';
import { calculateFactorScore } from '../decision_engine/factor_score.js';
import { applyRiskAdjustment } from '../decision_engine/risk_adjustment.js';
import { rankStocks } from '../decision_engine/rank_engine.js';
import { generateDecision } from '../decision_engine/decision_output.js';
import { evaluate } from '../run.js';

function model(candidates, market = 'normal') {
  const normalized = normalizeCandidates(candidates);
  const scored = normalized.map(calculateFactorScore);
  const adjusted = scored.map(stock => applyRiskAdjustment(stock, market));
  return { adjusted, ranking: rankStocks(adjusted) };
}

const pristine = {
  capitalScore: 100, trendScore: 100, sectorScore: 100, volumeScore: 100, catalystScore: 100,
  shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
};
const second = {
  capitalScore: 95, trendScore: 94, sectorScore: 92, volumeScore: 90, catalystScore: 85,
  shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
};

{
  const result = evaluate([{ ...pristine, symbol: 'A' }, { ...second, symbol: 'B' }], 'normal');
  assert.equal(result.action, 'BUY');
  assert.deepEqual(result.portfolio.map(item => item.weight), [70, 30]);
  assert.ok(result.ranking[0].adjustedScore >= 90);
  assert.ok(result.ranking[1].adjustedScore >= 85);
}
{
  const base = model([{ ...pristine, symbol: 'STEADY' }]).ranking[0];
  const highRisk = model([{
    ...pristine, symbol: 'HIGH_RISK', shortTermGainPct: 40,
    volatilityPct: 20, avgTurnover20dCny: 1_000_000
  }]).ranking[0];
  assert.ok(highRisk.adjustedScore < base.adjustedScore);
  assert.ok(highRisk.riskPenalty > 40);
}
{
  const result = evaluate([{ ...pristine, symbol: 'A' }, { ...second, symbol: 'B' }], 'weak');
  assert.equal(normalizeMarketRisk('弱'), 'weak');
  assert.equal(result.action, 'WAIT');
}
{
  assert.doesNotThrow(() => evaluate([{ symbol: 'MISSING', capitalScore: 'not-a-number' }], 'normal'));
  const result = evaluate([{ symbol: 'MISSING', capitalScore: 'not-a-number' }], 'normal');
  assert.notEqual(result.action, 'BUY');
  assert.equal(result.ranking[0].dataComplete, false);
  assert.ok(result.ranking[0].riskPenalty >= 50);
}
{
  const result = evaluate([{ ...pristine, symbol: 'DUP' }, { ...second, symbol: 'DUP' }], 'normal');
  assert.equal(result.ranking.length, 1);
  assert.notEqual(result.action, 'BUY');
}
{
  assert.deepEqual(rankStocks(null), []);
  assert.equal(generateDecision([], 'unknown').action, 'WAIT');
  assert.deepEqual(normalizeCandidates(null), []);
}
console.log('V10.4.0 CORE tests: PASS');
