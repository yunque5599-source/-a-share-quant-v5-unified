import { clamp, finiteNumber, round } from './schema.js';

export const TIMING_WEIGHTS = Object.freeze({
  trendStage: 0.40,
  capitalLead: 0.35,
  chaseSafety: 0.25
});
export const TIMING_VERSION = 'V11 Buy Timing Phase 1';

const stageScores = Object.freeze({
  startup: 90,
  acceleration: 78,
  mature: 52,
  range: 45,
  'high-risk': 20
});
const capitalScores = Object.freeze({
  'early-inflow': 90,
  'recent-inflow': 62,
  'late-high-inflow': 25,
  outflow: 20
});
const chaseScores = Object.freeze({
  normal: 90,
  elevated: 55,
  high: 20
});

const n = value => finiteNumber(value);
const metric = value => value === null || !Number.isFinite(value) ? null : round(value);

function signalFor(score) {
  if (score === null) return 'UNKNOWN';
  if (score >= 75) return 'BUY_NOW';
  if (score >= 50) return 'WAIT_PULLBACK';
  return 'AVOID';
}

/**
 * Calculate an execution-timing score without changing Alpha or its weights.
 * Missing stage/flow/risk evidence returns null rather than silently treating it
 * as a favorable entry.
 */
export function scoreTiming(record = {}) {
  const momentum = record?.features?.momentum ?? {};
  const capital = record?.features?.capital ?? {};
  const stage = stageScores[momentum.trendStage] ?? null;
  const capitalLead = capitalScores[capital.flowTiming] ?? null;
  const chaseRisk = chaseScores[momentum.overboughtRisk] ?? null;
  const known = [stage, capitalLead, chaseRisk].every(value => value !== null);
  const scoreRaw = known
    ? clamp(stage * TIMING_WEIGHTS.trendStage +
      capitalLead * TIMING_WEIGHTS.capitalLead +
      chaseRisk * TIMING_WEIGHTS.chaseSafety)
    : null;
  const reasons = [];
  if (momentum.trendStage) reasons.push('trend-' + momentum.trendStage);
  if (capital.flowTiming) reasons.push('capital-' + capital.flowTiming);
  if (momentum.overboughtRisk) reasons.push('chase-' + momentum.overboughtRisk);
  if (momentum.overboughtRisk === 'high') reasons.push('avoid-overbought');
  return {
    version: TIMING_VERSION,
    score: metric(scoreRaw),
    scoreRaw,
    signal: signalFor(scoreRaw),
    stage: momentum.trendStage ?? 'unknown',
    capitalTiming: capital.flowTiming ?? 'unknown',
    overboughtRisk: momentum.overboughtRisk ?? 'unknown',
    components: {
      trendStage: { score: stage, weight: TIMING_WEIGHTS.trendStage },
      capitalLead: { score: capitalLead, weight: TIMING_WEIGHTS.capitalLead },
      chaseSafety: { score: chaseRisk, weight: TIMING_WEIGHTS.chaseSafety }
    },
    reasons
  };
}

export function withTiming(record = {}) {
  const timing = scoreTiming(record);
  const alphaRaw = n(record?.scores?.alphaRaw ?? record?.scores?.alpha);
  const compositeRaw = alphaRaw !== null && timing.scoreRaw !== null
    ? alphaRaw * 0.70 + timing.scoreRaw * 0.30 : null;
  return {
    ...record,
    scores: {
      ...(record.scores ?? {}),
      timing: timing.score,
      timingRaw: timing.scoreRaw,
      composite: metric(compositeRaw),
      compositeRaw
    },
    timing,
    timingEligible: timing.scoreRaw !== null && timing.scoreRaw >= 50
  };
}
