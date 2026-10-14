import { asOfDate } from './schema.js';
import { classifyMarketRegime } from './market_regime.js';

export const REGIME_EXECUTION_VERSION = 'V12 Market Regime Execution Gate v1';
export const DEFAULT_NEUTRAL_EVERY = 2;
export const REGIME_EXECUTION_STATES = Object.freeze(['bull', 'neutral', 'bear', 'unknown']);

function signalOf(candidate = {}) {
  const explicit = candidate?.timing?.signal ?? candidate?.timingSignal;
  if (typeof explicit === 'string') return explicit.toUpperCase();
  const value = Number(candidate?.scores?.timingRaw ?? candidate?.scores?.timing);
  if (!Number.isFinite(value)) return 'UNKNOWN';
  return value >= 75 ? 'BUY_NOW' : value >= 50 ? 'WAIT_PULLBACK' : 'AVOID';
}

function stateOf(regime) {
  if (regime === 'bull') return 'bull';
  if (regime === 'sideways') return 'neutral';
  if (regime === 'bear') return 'bear';
  return 'unknown';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * Execution policy only. It does not change Alpha, Timing, Psychology, or rank.
 * neutralOrdinal is zero-based and must be advanced once per chronological
 * neutral snapshot so cadence remains stable across folds and portfolios.
 */
export function evaluateRegimeExecution(snapshot = {}, options = {}) {
  const classification = classifyMarketRegime(snapshot);
  const regime = classification.regime;
  const state = stateOf(regime);
  const neutralEvery = positiveInteger(options.neutralEvery, DEFAULT_NEUTRAL_EVERY);
  const neutralOrdinal = Number.isInteger(options.neutralOrdinal)
    ? options.neutralOrdinal : 0;
  const cadenceEligible = state !== 'neutral' ||
    neutralOrdinal % neutralEvery === 0;
  if (state === 'bull') {
    return {
      version: REGIME_EXECUTION_VERSION, regime, state,
      action: 'BUY_NOW', exposure: 1, frequencyEligible: true,
      neutralOrdinal, neutralEvery, classification,
      reason: 'bull-allows-buy-now'
    };
  }
  if (state === 'neutral') {
    return {
      version: REGIME_EXECUTION_VERSION, regime, state,
      action: cadenceEligible ? 'BUY_NOW' : 'WAIT',
      exposure: cadenceEligible
        ? Math.min(1, Math.max(0, Number(options.neutralExposure ?? 0.5)))
        : 0,
      frequencyEligible: cadenceEligible,
      neutralOrdinal, neutralEvery, classification,
      reason: cadenceEligible ? 'neutral-half-exposure' : 'neutral-cadence-wait'
    };
  }
  return {
    version: REGIME_EXECUTION_VERSION, regime, state,
    action: 'WAIT', exposure: 0, frequencyEligible: false,
    neutralOrdinal, neutralEvery, classification,
    reason: state === 'bear' ? 'bear-buy-now-disabled' : 'unknown-buy-now-disabled'
  };
}

export function canExecuteBuyNow(policy, candidate = {}) {
  return policy?.action === 'BUY_NOW' && signalOf(candidate) === 'BUY_NOW';
}

export function candidateTimingSignal(candidate = {}) {
  return signalOf(candidate);
}

export function normalizeExecutionAsOf(snapshot = {}) {
  return asOfDate(snapshot?.asOf ?? snapshot?.date ?? snapshot?.generatedAt);
}
