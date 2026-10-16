import { clamp, finiteNumber, round } from './schema.js';
import { computeV12TradeScore } from './v12_trade_score.js';

export const V12_SELECTION_VERSION = 'V12 Short-Horizon Selection Score v1';
export const V12_SELECTION_WEIGHTS = Object.freeze({
  alpha:0.60, timing:0.25, psychology:0.15
});

/**
 * Selection score is intentionally score-compatible with the frozen V12 baseline.
 * It ranks short-horizon opportunity quality without adding a new factor.
 */
export function computeV12SelectionScore(candidate = {}) {
  const trade = computeV12TradeScore(candidate);
  if (!trade) return null;
  const scoreRaw = clamp(trade.scoreRaw);
  return {
    version:V12_SELECTION_VERSION,
    scoreRaw,
    score:round(scoreRaw),
    alpha:trade.alpha,
    timing:trade.timing,
    psychology:trade.psychology,
    weights:V12_SELECTION_WEIGHTS,
    horizonTarget:'T+1..T+5 cross-sectional selection'
  };
}

export function withV12SelectionScore(candidate = {}) {
  const result = computeV12SelectionScore(candidate);
  return {
    ...candidate,
    scores:{
      ...(candidate.scores ?? {}),
      v12Selection:result?.score ?? null,
      v12SelectionRaw:result?.scoreRaw ?? null
    },
    v12Selection:result
  };
}

export function selectionScoreOf(candidate = {}) {
  return finiteNumber(candidate?.scores?.v12SelectionRaw ??
    candidate?.scores?.v12Selection ?? candidate?.selectionScore ??
    candidate?.scores?.v12TradeRaw ?? candidate?.scores?.v12Trade);
}
