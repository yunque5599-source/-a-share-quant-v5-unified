# V10.4.0 CORE

Research-only A-share short-term quantitative decision engine. It is isolated under
research/v1040-core and does not change index.html, api/market.js,
api/discovery_universe.js, or existing production BUY/WAIT rules.

## Factor model

The fixed weights are:

- funds 30%: average 20-session turnover, net inflow intensity, consecutive inflow strength;
- trend 25%: five-session gain, 20-session return, and MA5/MA10/MA20 structure;
- industry 20%: sector percentage change and sector rank percentile;
- short-term strength 15%: volume expansion, breakout, and strong-stock signals;
- catalyst 10%: explicit catalyst input only.

History is read from the deep market response shape (kline.data.klines and
flow.data.klines) or historyBySymbol/flowBySymbol maps. K-line rows are sorted by
date before five/20-session calculations. Daily return standard deviation supplies the
risk volatility input, and the last 20 CNY amounts supply liquidity risk.

The adapter deliberately does not use rankScore as a funds score, f24/pct60 as a
five-day return, or f10 as volatility. Missing history stays null, receives a quality
warning, and prevents BUY through the existing complete-data gate.

## Decisions

BUY requires a normal market, distinct complete TOP1/TOP2, adjusted scores of at least
90/85, and the existing 70%/30% allocation. Weak or unknown markets force WAIT.

## Run and tests

From the repository root:

    node research/v1040-core/run.js
    node research/v1040-core/tests/decision_test.js
    node research/v1040-core/tests/real_data_test.js
    node research/v1040-core/tests/real006_factor_test.js

REAL-006 historical simulation:

    node research/v1040-core/run.js --input research/v1040-core/tests/fixtures/real006_history_payload.json --date 2026-10-12 --market normal

The CLI prints TOP1, TOP2, Score, and Decision, then writes
data/predictions/YYYY-MM-DD.json. The simulation uses only an injected provider-shaped
fixture; it does not call or modify either production API. Passing --market overrides
index-derived risk.

Dashboard and Shadow validation remain deferred.
