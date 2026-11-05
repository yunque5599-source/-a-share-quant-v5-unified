import { clamp, finiteNumber } from '../adapter/candidate_adapter.js';
import { normalizeMarketRisk } from '../adapter/market_adapter.js';

export const MARKET_PENALTIES = Object.freeze({
  normal: 0,
  elevated: 10,
  weak: 25,
  unknown: 25
});

function round(value) {
  return Math.round(value * 100) / 100;
}

function boundedPenalty(value, missingPenalty, calculate) {
  const number = finiteNumber(value);
  return number === null ? missingPenalty : calculate(number);
}

export function applyRiskAdjustment(stock = {}, marketInput = 'unknown') {
  const marketRisk = normalizeMarketRisk(marketInput);
  const gainRisk = boundedPenalty(stock.shortTermGainPct, 20,
    value => clamp((value - 12) * 0.8, 0, 20));
  const volatilityRisk = boundedPenalty(stock.volatilityPct, 15,
    value => clamp((value - 3) * 2.5, 0, 15));
  const liquidityRisk = boundedPenalty(stock.avgTurnover20dCny, 15,
    value => clamp(((50_000_000 - value) / 50_000_000) * 15, 0, 15));
  const marketRiskPenalty = MARKET_PENALTIES[marketRisk];
  const missingRiskInputs = [
    ['shortTermGainPct', stock.shortTermGainPct],
    ['volatilityPct', stock.volatilityPct],
    ['avgTurnover20dCny', stock.avgTurnover20dCny]
  ].filter(([, value]) => finiteNumber(value) === null).map(([field]) => field);
  const riskPenalty = gainRisk + volatilityRisk + liquidityRisk + marketRiskPenalty;
  const factorScore = finiteNumber(stock.factorScore) ?? 0;
  const adjustedScore = clamp(factorScore - riskPenalty);
  const dataComplete = Boolean(stock.factorComplete) &&
    missingRiskInputs.length === 0 &&
    marketRisk !== 'unknown';
  return {
    ...stock,
    marketRisk,
    risks: {
      shortTermGain: round(gainRisk),
      volatility: round(volatilityRisk),
      liquidity: round(liquidityRisk),
      market: marketRiskPenalty
    },
    riskPenalty: round(riskPenalty),
    adjustedScore: round(adjustedScore),
    dataComplete,
    missingRiskInputs
  };
}

export const adjustRisk = applyRiskAdjustment;
