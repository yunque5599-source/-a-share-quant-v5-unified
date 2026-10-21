export const V11_SCHEMA = 'v11-short-alpha-candidate-v1';
export const ALPHA_WEIGHTS = Object.freeze({
  capital: 0.30, momentum: 0.25, sector: 0.20, volume: 0.15, risk: 0.10
});

export function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clamp(value, min = 0, max = 100) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(max, Math.max(min, number));
}

export function round(value) {
  return Math.round(value * 100) / 100;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function asOfDate(value) {
  if (typeof value !== 'string') return null;
  if (validDate(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const part = name => parts.find(item => item.type === name)?.value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

/** Canonical 0..100 factor scores; risk is a positive safety score. */
export function createCandidateRecord(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const features = Object.fromEntries(Object.keys(ALPHA_WEIGHTS).map(name => {
    const feature = input.features?.[name];
    const value = feature && typeof feature === 'object' ? feature : {};
    return [name, { ...value, score: clamp(value.score) }];
  }));
  const missing = [...new Set([
    ...strings(input.quality?.missing),
    ...Object.keys(ALPHA_WEIGHTS).filter(name => features[name].score === null)
  ])];
  const blockedReasons = strings(input.quality?.blockedReasons);
  const quality = {
    ...input.quality, missing, blockedReasons,
    warnings: strings(input.quality?.warnings),
    degraded: input.quality?.degraded === true,
    stale: input.quality?.stale === true
  };
  quality.complete = input.quality?.complete !== false && missing.length === 0 &&
    blockedReasons.length === 0 && !quality.degraded && !quality.stale;
  const record = {
    schema: V11_SCHEMA, modelVersion: 'V11 Short Alpha Phase 1',
    asOf: input.asOf ?? null, symbol: String(input.symbol ?? input.code ?? '').trim(),
    name: String(input.name ?? input.symbol ?? input.code ?? '').trim(),
    industry: input.industry ?? null, price: finiteNumber(input.price),
    marketRisk: input.marketRisk ?? 'unknown', source: { ...input.source },
    features, quality, scores: { alpha: null, alphaRaw: null, components: {} }
  };
  // Research-only fields are preserved without entering ALPHA_WEIGHTS or quality gates.
  if (input.features?.trendStructure !== undefined) {
    record.features.trendStructure = input.features.trendStructure;
  }
  // Independent low-level opportunity research factor; never part of ALPHA_WEIGHTS.
  if (input.features?.earlyOpportunity !== undefined) {
    record.features.earlyOpportunity = input.features.earlyOpportunity;
  }
  return record;
}
