import { clamp, finiteNumber } from '../adapter/candidate_adapter.js';

export const FACTOR_WEIGHTS = Object.freeze({
  capitalScore: 0.30,
  trendScore: 0.25,
  sectorScore: 0.20,
  volumeScore: 0.15,
  catalystScore: 0.10
});

function round(value) {
  return Math.round(value * 100) / 100;
}

export function calculateFactorScore(stock = {}) {
  const factors = {};
  const missingFactors = [];
  let baseScore = 0;
  for (const [field, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const rawValue = field === 'volumeScore'
      ? stock.volumeScore ?? stock.shortTermScore
      : stock[field];
    const value = finiteNumber(rawValue);
    if (value === null) {
      factors[field] = null;
      missingFactors.push(field);
      continue;
    }
    factors[field] = clamp(value);
    baseScore += factors[field] * weight;
  }
  return {
    ...stock,
    factors,
    factorScore: round(clamp(baseScore)),
    factorScoreRaw: baseScore,
    factorComplete: missingFactors.length === 0,
    missingFactors
  };
}

export const scoreFactors = calculateFactorScore;
