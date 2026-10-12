const ALIASES = Object.freeze({
  normal: new Set(['normal', '正常', 'low', '低', 'healthy', 'bull', 'safe']),
  elevated: new Set(['elevated', '中', 'medium', 'caution']),
  weak: new Set(['weak', '弱', 'bear', 'crash', 'extreme', 'very_high', 'high', '高']),
  unknown: new Set(['', 'unknown', '未知', 'n/a', 'na', 'null', 'undefined'])
});

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
