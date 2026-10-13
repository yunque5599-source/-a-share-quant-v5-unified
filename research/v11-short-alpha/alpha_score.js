import { ALPHA_WEIGHTS, createCandidateRecord, finiteNumber, round } from './schema.js';
import { withTiming } from './timing_score.js';

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
  const timed = withTiming({
    ...record,
    scores: { alpha: round(alphaRaw), alphaRaw, components }
  });
  return {
    ...timed,
    reasons: [
      ...record.quality.blockedReasons,
      ...record.quality.missing.map(field => 'missing:' + field),
      ...Object.entries(components).filter(([, part]) => part.score >= 75)
        .map(([name]) => name + '-strong'),
      record.features.momentum?.trendStage && 'trend-' + record.features.momentum.trendStage,
      record.features.momentum?.overboughtRisk === 'high' && 'overbought-risk-high',
      record.features.momentum?.overboughtRisk === 'elevated' && 'overbought-risk-elevated',
      record.features.capital?.flowTiming === 'early-inflow' && 'capital-early-inflow',
      record.features.capital?.flowTiming === 'late-high-inflow' && 'capital-late-high-inflow',
      timed.timing?.signal === 'BUY_NOW' && 'timing-buy-now',
      timed.timing?.signal === 'WAIT_PULLBACK' && 'timing-wait-pullback',
      timed.timing?.signal === 'AVOID' && 'timing-avoid'
    ].filter(Boolean)
  };
}

export function rankCandidates(input = [], options = {}) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const sortBy = options.sortBy === 'composite' || options.sortBy === 'timing'
    ? options.sortBy : 'alpha';
  const scored = input.map(scoreCandidate).filter(record => {
    if (!record.symbol || seen.has(record.symbol)) return false;
    seen.add(record.symbol);
    return true;
  });
  const value = record => {
    if (sortBy === 'composite') return finiteNumber(record.scores?.compositeRaw);
    if (sortBy === 'timing') return finiteNumber(record.scores?.timingRaw);
    return finiteNumber(record.scores?.alphaRaw);
  };
  scored.sort((a, b) => {
    const left = value(a), right = value(b);
    if (left === null && right === null) return a.symbol.localeCompare(b.symbol);
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || finiteNumber(b.scores?.alphaRaw) - finiteNumber(a.scores?.alphaRaw) ||
      a.symbol.localeCompare(b.symbol);
  });
  return scored.map((record, index) => ({ ...record, rank: index + 1 }));
}
