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
- a pure run() entry point with deterministic demo data;
- REAL-005 adapters for the read-only response shapes of api/market.js and
  api/discovery_universe.js.

Missing numeric data is kept as null, penalized conservatively, and never silently
treated as a positive score. Eastmoney ranked rows provide f12/f14/f2/f3/f6/f8/f24/f62/f184/f100
and rankScore; discovery records provide code/name/price/pct/amount/turn/pct60/mainNet/mainPct
and industry. Provider inputs lacking volatility history, liquidity history, or catalyst data
remain incomplete and cannot trigger BUY. The optional risk proxy flag is explicit.

## Run

From the repository root:

    node research/v1040-core/run.js
    node research/v1040-core/tests/decision_test.js
    node research/v1040-core/tests/real_data_test.js

Run the real-shape simulation without contacting either production API:

    node research/v1040-core/run.js --input research/v1040-core/tests/fixtures/real_ranked_candidates.json --date 2026-10-12

The input may be the ranked market response (data.candidates and data.indices) or the
discovery response (records and quality). The CLI prints TOP1, TOP2, Score, and Decision,
then writes data/predictions/YYYY-MM-DD.json. Set V1040_PREDICTION_DIR to redirect the
output for a local run. Passing --market overrides inferred index risk. Passing
--allow-risk-proxies permits explicitly documented provider proxies; it is off by default.

## Inputs

evaluate(candidates, market) accepts normalized candidates. evaluateReal(payload) accepts
the real provider shapes described above and never imports or calls the production API.
Market risk is normal, elevated, weak, or unknown; common Chinese and legacy aliases are
accepted. Without explicit risk, indices are averaged: non-negative is normal, mildly
negative is elevated, and <= -1.5 percent is weak. Discovery quality metadata is retained
as source metadata and does not create a BUY signal by itself.

Prediction JSON contains date, stock/symbol, score, reason, risk, and decision for each
ranked candidate. Dashboard, Shadow validation, and scheduled automation remain deferred.
