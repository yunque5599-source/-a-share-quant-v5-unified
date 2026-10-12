import { normalizeCandidates } from './adapter/candidate_adapter.js';
import { normalizeMarket } from './adapter/market_adapter.js';
import { calculateFactorScore } from './decision_engine/factor_score.js';
import { applyRiskAdjustment } from './decision_engine/risk_adjustment.js';
import { rankStocks } from './decision_engine/rank_engine.js';
import { generateDecision } from './decision_engine/decision_output.js';

export const DEMO_CANDIDATES = Object.freeze([
  {
    symbol: '600001', name: '示例强势股',
    capitalScore: 100, trendScore: 100, sectorScore: 100, volumeScore: 100, catalystScore: 100,
    shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
  },
  {
    symbol: '000002', name: '示例趋势股',
    capitalScore: 95, trendScore: 94, sectorScore: 92, volumeScore: 90, catalystScore: 85,
    shortTermGainPct: 6, volatilityPct: 2, avgTurnover20dCny: 100_000_000
  }
]);

export function evaluate(candidates = DEMO_CANDIDATES, marketInput = { marketRisk: 'normal' }) {
  const market = normalizeMarket(marketInput);
  const normalized = normalizeCandidates(candidates);
  const scored = normalized.map(calculateFactorScore);
  const adjusted = scored.map(stock => applyRiskAdjustment(stock, market.marketRisk));
  const ranking = rankStocks(adjusted);
  const decision = generateDecision(ranking, market.marketRisk);
  return { version: 'V10.4.0 CORE', market, ranking, ...decision };
}

function displayScore(stock) {
  return stock ? String(stock.adjustedScore) : '-';
}

export function printResult(result) {
  const [top1, top2] = result?.ranking ?? [];
  console.log('V10.4.0 CORE');
  console.log('TOP1');
  console.log('股票: ' + (top1?.name || top1?.symbol || '-'));
  console.log('评分: ' + displayScore(top1));
  console.log('TOP2');
  console.log('股票: ' + (top2?.name || top2?.symbol || '-'));
  console.log('评分: ' + displayScore(top2));
  console.log('Decision: ' + (result?.action || 'WAIT'));
}

export function run(options = {}) {
  const result = evaluate(
    options.candidates ?? DEMO_CANDIDATES,
    options.market ?? { marketRisk: 'normal' }
  );
  printResult(result);
  return result;
}

const invokedDirectly = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL('file://' + process.argv[1]).pathname;
if (invokedDirectly) run();
