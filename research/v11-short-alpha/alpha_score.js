import { ALPHA_WEIGHTS, createCandidateRecord, round } from './schema.js';

export { ALPHA_WEIGHTS };

export function scoreCandidate(input = {}) {
  // Revalidate even when a caller supplies complete=true.
  const record = createCandidateRecord(input);
  const components = {};
  let alphaRaw = 0;
  for (const [name, weight] of Object.entries(ALPHA_WEIGHTS)) {
    const score = record.features[name].score;
    const contribution = (score ?? 0) * weight;
    alphaRaw += contribution;
    components[name] = { score, weight, contribution };
  }
  return {
    ...record,
    scores: { alpha: round(alphaRaw), alphaRaw, components },
    reasons: [
      ...record.quality.blockedReasons,
      ...record.quality.missing.map(field => 'missing:' + field),
      ...Object.entries(components).filter(([, part]) => part.score >= 75)
        .map(([name]) => name + '-strong'),
      record.features.momentum?.trendStage && 'trend-' + record.features.momentum.trendStage,
      record.features.momentum?.overboughtRisk === 'high' && 'overbought-risk-high',
      record.features.momentum?.overboughtRisk === 'elevated' && 'overbought-risk-elevated',
      record.features.capital?.flowTiming === 'early-inflow' && 'capital-early-inflow',
      record.features.capital?.flowTiming === 'late-high-inflow' && 'capital-late-high-inflow'
    ].filter(Boolean)
  };
}

export function rankCandidates(input = []) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.map(scoreCandidate).filter(record => {
    if (!record.symbol || seen.has(record.symbol)) return false;
    seen.add(record.symbol);
    return true;
  }).sort((a, b) => b.scores.alphaRaw - a.scores.alphaRaw ||
    a.symbol.localeCompare(b.symbol))
    .map((record, index) => ({ ...record, rank: index + 1 }));
}
