import { clamp, finiteNumber } from './candidate_adapter.js';

const ALIASES = Object.freeze({
  normal: new Set(['normal', '正常', 'low', '低', 'healthy', 'bull', 'safe']),
  elevated: new Set(['elevated', '中', 'medium', 'caution']),
  weak: new Set(['weak', '弱', 'bear', 'crash', 'extreme', 'very_high', 'high', '高']),
  unknown: new Set(['', 'unknown', '未知', 'n/a', 'na', 'null', 'undefined'])
});

function firstFinite(source, keys) {
  for (const key of keys) {
    const value = finiteNumber(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizePercent(value, center = 0, multiplier = 5) {
  const number = finiteNumber(value);
  return number === null ? null : clamp(50 + (number - center) * multiplier);
}

function amountScore(value) {
  const amount = finiteNumber(value);
  if (amount === null || amount <= 0) return null;
  return clamp((Math.log10(amount) - 6) * 25);
}

function average(values) {
  const valid = values.map(finiteNumber).filter(value => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

export function normalizeMarketRisk(input) {
  const raw = typeof input === 'string'
    ? input
    : input?.marketRisk ?? input?.riskLevel ?? input?.status ?? input?.risk ?? '';
  const value = String(raw ?? '').trim().toLowerCase();
  for (const [status, values] of Object.entries(ALIASES)) {
    if (values.has(value)) return status;
  }
  return 'unknown';
}

export function inferMarketRisk(indices = [], explicitRisk = null) {
  const explicit = normalizeMarketRisk(explicitRisk);
  if (explicit !== 'unknown') return explicit;
  const averageIndexPct = average(
    Array.isArray(indices) ? indices.map(item => item?.pct ?? item?.changePct) : []
  );
  if (averageIndexPct === null) return 'unknown';
  if (averageIndexPct <= -1.5) return 'weak';
  if (averageIndexPct < 0) return 'elevated';
  return 'normal';
}

export function normalizeMarket(input = {}) {
  const marketRisk = normalizeMarketRisk(input);
  return {
    marketRisk,
    status: marketRisk,
    known: marketRisk !== 'unknown',
    source: input && typeof input === 'object' ? input.source ?? null : null,
    reason: input && typeof input === 'object' ? input.reason ?? null : null
  };
}

export function adaptMarketCandidate(raw = {}, context = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const symbol = String(source.symbol ?? source.code ?? source.f12 ?? '').trim();
  const name = String(source.name ?? source.stockName ?? source.f14 ?? symbol).trim();
  const dayPct = firstFinite(source, ['pct', 'dayPct', 'f3']);
  const pct60 = firstFinite(source, ['pct60', 'f24']);
  const mainPct = firstFinite(source, ['mainPct', 'mainNetPct', 'f184']);
  const amount = firstFinite(source, ['amount', 'f6']);
  const turnover = firstFinite(source, ['turn', 'turnover', 'f8']);
  const rankScore = firstFinite(source, ['rankScore', 'score']);
  const industry = String(source.industry ?? source.f100 ?? '').trim();
  const sectorScore = firstFinite(source, ['sectorScore', 'industryScore']) ??
    finiteNumber(context.sectorScores?.[industry]);
  const amountComponent = amountScore(amount);
  const turnoverComponent = turnover === null ? null : clamp(turnover * 8);
  const volumeScore = firstFinite(source, ['volumeScore', 'volumePriceScore']) ??
    (amountComponent === null && turnoverComponent === null
      ? null
      : (amountComponent ?? 50) * 0.7 + (turnoverComponent ?? 50) * 0.3);

  const trendScore = firstFinite(source, ['trendScore', 'trendQualityScore']) ??
    (dayPct === null && pct60 === null
      ? null
      : (normalizePercent(dayPct, 0, 5) ?? 50) * 0.65 +
        (normalizePercent(pct60, 0, 1.5) ?? 50) * 0.35);
  const capitalScore = firstFinite(source, ['capitalScore', 'fundsScore']) ??
    (rankScore ?? (mainPct === null ? null : normalizePercent(mainPct, 0, 4)));
  const catalystScore = firstFinite(source, ['catalystScore', 'catalyst']) ??
    finiteNumber(context.catalystScores?.[symbol]);

  const allowRiskProxies = context.allowRiskProxies === true;
  const shortTermGainPct = firstFinite(source, ['shortTermGainPct', 'gain5dPct', 'recentGainPct']) ??
    (allowRiskProxies ? pct60 : null);
  const volatilityPct = firstFinite(source, ['volatilityPct', 'vol20dPct', 'volatility20dPct']) ??
    (allowRiskProxies ? firstFinite(source, ['amplitudePct', 'amplitude', 'f10']) : null);
  const avgTurnover20dCny = firstFinite(source, ['avgTurnover20dCny', 'averageTurnover20dCny', 'avgTurnover20d']) ??
    (allowRiskProxies ? amount : null);

  const warnings = [];
  if (rankScore !== null) warnings.push('capitalScore-from-market-rankScore');
  if (dayPct !== null || pct60 !== null) warnings.push('trendScore-from-provider-percent-change');
  if (sectorScore === null) warnings.push('industry-strength-unavailable');
  if (catalystScore === null) warnings.push('catalyst-data-unavailable');
  if (shortTermGainPct === null || volatilityPct === null || avgTurnover20dCny === null) {
    warnings.push('risk-history-incomplete');
  }
  return {
    symbol,
    name,
    industry: industry || null,
    capitalScore,
    trendScore,
    sectorScore,
    volumeScore,
    catalystScore,
    shortTermGainPct,
    volatilityPct,
    avgTurnover20dCny,
    currentPrice: firstFinite(source, ['currentPrice', 'price', 'f2']),
    providerPct: dayPct,
    providerPct60: pct60,
    providerAmount: amount,
    providerTurnover: turnover,
    providerMainNet: firstFinite(source, ['mainNet', 'f62']),
    providerMainPct: mainPct,
    providerRankScore: rankScore,
    source: context.source ?? source.source ?? 'market-adapter',
    dataQualityWarnings: warnings,
    rawProviderFields: {
      code: source.code ?? source.f12 ?? null,
      name: source.name ?? source.f14 ?? null,
      quoteAt: source.quoteAt ?? null
    }
  };
}

function payloadRoot(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

export function adaptMarketPayload(payload = {}, options = {}) {
  const root = payloadRoot(payload) ?? {};
  const candidates = Array.isArray(root)
    ? root
    : root.candidates ?? root.records ?? root.items ?? [];
  const source = root.records ? 'discovery_universe.js' : 'market.js';
  const sectors = root.sectorResearch?.sectors ?? payload?.sectorResearch?.sectors ?? [];
  const sectorScores = Object.fromEntries(
    (Array.isArray(sectors) ? sectors : []).map(sector => [
      sector.industry,
      normalizePercent(sector.medianPct, 0, 5)
    ]).filter(([, score]) => score !== null)
  );
  const marketRisk = inferMarketRisk(
    root.indices ?? payload?.indices ?? [],
    options.marketRisk ?? root.marketRisk ?? payload?.marketRisk
  );
  const market = {
    marketRisk,
    status: marketRisk,
    source,
    generatedAt: root.generatedAt ?? payload?.generatedAt ?? null,
    indices: root.indices ?? payload?.indices ?? [],
    quality: root.quality ?? payload?.quality ?? null,
    reason: marketRisk === 'unknown' ? 'No explicit market risk or usable index breadth.' : 'Derived from explicit risk or index percentage changes.'
  };
  return {
    market,
    candidates: (Array.isArray(candidates) ? candidates : [])
      .map(item => adaptMarketCandidate(item, {
        ...options,
        source,
        sectorScores
      }))
      .filter(candidate => candidate.symbol),
    source,
    metadata: {
      schema: root.schema ?? null,
      method: root.method ?? null,
      generatedAt: root.generatedAt ?? null,
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      quality: root.quality ?? null
    }
  };
}

export const adaptRealCandidate = adaptMarketCandidate;
export const adaptRealPayload = adaptMarketPayload;
