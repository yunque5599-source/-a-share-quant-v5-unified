const FACTOR_FIELDS = Object.freeze({
  capitalScore: ['capitalScore', 'fundsScore', 'fundingScore'],
  trendScore: ['trendScore', 'trendQualityScore'],
  sectorScore: ['sectorScore', 'industryScore'],
  volumeScore: ['shortTermScore', 'volumeScore', 'volumePriceScore', 'priceVolumeScore'],
  catalystScore: ['catalystScore', 'catalyst']
});

const RISK_FIELDS = Object.freeze({
  shortTermGainPct: ['shortTermGainPct', 'gain5dPct', 'recentGainPct', 'shortTermGain'],
  volatilityPct: ['volatilityPct', 'vol20dPct', 'volatility20dPct', 'volatility'],
  avgTurnover20dCny: [
    'avgTurnover20dCny', 'averageTurnover20dCny', 'avgTurnover20d',
    'turnover20dCny', 'avgTurnover', 'liquidityCny', 'amount'
  ]
});

export function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      typeof value === 'object') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clamp(value, min = 0, max = 100) {
  const number = finiteNumber(value);
  if (number === null) return min;
  return Math.min(max, Math.max(min, number));
}

function firstFinite(source, aliases) {
  for (const alias of aliases) {
    const value = finiteNumber(source?.[alias]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeCandidate(raw = {}, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const symbol = String(source.symbol ?? source.code ?? '').trim();
  const factors = Object.fromEntries(
    Object.entries(FACTOR_FIELDS).map(([field, aliases]) => [field, firstFinite(source, aliases)])
  );
  const risks = Object.fromEntries(
    Object.entries(RISK_FIELDS).map(([field, aliases]) => [field, firstFinite(source, aliases)])
  );
  const missingFactors = Object.keys(factors).filter(field => factors[field] === null);
  const missingRisks = Object.keys(risks).filter(field => risks[field] === null);
  return {
    ...source,
    symbol,
    name: String(source.name ?? source.stockName ?? symbol).trim(),
    ...factors,
    shortTermScore: factors.volumeScore,
    ...risks,
    sourceIndex: index,
    factorComplete: missingFactors.length === 0,
    riskInputComplete: missingRisks.length === 0,
    missingFactors,
    missingRisks
  };
}

export function normalizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((item, index) => normalizeCandidate(item, index)).filter(item => {
    if (!item.symbol || seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });
}
