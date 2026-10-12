# V10.4.0 CORE

Research-only A-share short-term quantitative decision engine. It is isolated under
research/v1040-core and does not change index.html, api/market.js,
api/discovery_universe.js, or existing production BUY/WAIT rules.

## MVP

The ESM modules implement:

- factor score: funds 30%, trend quality 25%, industry strength 20%, volume-price 15%, catalyst 10%;
- conservative risk adjustment for short-term gain, volatility, liquidity, and market state;
- deterministic adjusted-score ranking;
- BUY only when market risk is normal, TOP1 is at least 90, TOP2 is at least 85,
  both candidates have complete factor and risk data, and symbols are distinct;
- WATCH for a complete candidate at least 70 when market risk is normal or elevated;
  weak or unknown markets force WAIT;
- a pure run() entry point with deterministic demo data.

Missing numeric data is kept as null, penalized conservatively, and never silently
treated as a positive score. Prediction persistence, Shadow validation, Dashboard,
and scheduled automation are deferred to a later phase.

## Run

From the repository root:

    node research/v1040-core/run.js
    node research/v1040-core/tests/decision_test.js

The output includes V10.4.0 CORE, TOP1/TOP2 stock and score, and Decision.

## Inputs

evaluate(candidates, market) accepts candidates with symbol or code and factor fields
capitalScore, trendScore, sectorScore, volumeScore, catalystScore. Risk inputs are
shortTermGainPct, volatilityPct, and avgTurnover20dCny. Scores are clamped to 0..100.
Numeric strings are accepted; empty or invalid values remain missing. Market risk is
normal, elevated, weak, or unknown; common Chinese and legacy aliases are accepted.
