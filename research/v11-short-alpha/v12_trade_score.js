import { clamp, finiteNumber, round } from './schema.js';

export const V12_TRADE_WEIGHTS = Object.freeze({ alpha: 0.60, timing: 0.25, psychology: 0.15 });
export const V12_TRADE_VERSION = 'V12 Trade Score Phase 1';

export function computeV12TradeScore(candidate = {}) {
  const alpha = finiteNumber(candidate?.scores?.alphaRaw ?? candidate?.scores?.alpha);
  const timing = finiteNumber(candidate?.scores?.timingRaw ?? candidate?.scores?.timing);
  const psychology = finiteNumber(candidate?.scores?.psychologyRaw ??
    candidate?.scores?.psychology ?? candidate?.psychology?.score);
  if ([alpha, timing, psychology].some(value => value === null)) return null;
  const scoreRaw = clamp(alpha * 0.60 + timing * 0.25 + psychology * 0.15);
  return {version: V12_TRADE_VERSION, alpha, timing, psychology,
    scoreRaw, score: round(scoreRaw), weights: V12_TRADE_WEIGHTS};
}

export function withV12TradeScore(candidate = {}) {
  const result = computeV12TradeScore(candidate);
  return {...candidate, scores:{...(candidate.scores ?? {}),
    v12Trade: result?.score ?? null, v12TradeRaw: result?.scoreRaw ?? null},
    v12Trade: result};
}
