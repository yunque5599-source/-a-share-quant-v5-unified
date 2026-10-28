# V13 Adaptive Regime Shadow

## Scope

V13 is an isolated research/shadow dashboard. It does not connect to a brokerage account, submit orders, or replace the current default page. The existing `index.html` baseline remains unchanged.

## What changed

- Added `regime-engine.js`: deterministic five-state classification, state-specific scoring weights, risk budget, position sizing, target bands, and maximum holding horizon.
- Added `api/market.js?action=index_kline&index=<code>`: historical daily bars for allowlisted broad indices, used to calculate 5-day/20-day trend, 20-day drawdown, and ATR proxy.
- Added `index_V13_ADAPTIVE_REGIME_SHADOW.html`: uses the adaptive engine for first-stage ranking, final ranking, candidate entry gates, position sizing, and holding review.
- Added `regime-engine.test.js` and CI checks for API syntax, dashboard inline-module syntax, policy-weight normalization, state classification, and risk sizing.

## Market states

| State | Entry policy | Max position cap before data-quality haircut | Per-trade risk budget | Max holding horizon |
|---|---|---:|---:|---:|
| Bull trend | Trend/leader continuation | 35% | 1.8% of strategy capital | 8 trading days |
| Rotation | Sector and flow selectivity | 25% | 1.2% | 5 trading days |
| Bear trend | High threshold, relative strength only | 12% | 0.6% | 3 trading days |
| Recovery | Confirmed breadth improvement, gradual risk | 18% | 0.8% | 5 trading days |
| Extreme risk | Lock new entries; review existing positions defensively | 0% | 0% | 2 trading days |

These are initial research parameters, not empirically optimized values or return guarantees. The engine applies a 25% haircut to position caps and risk budgets when it only has the ranked-candidate breadth proxy.

## Inputs and data-quality rules

1. Current index percentage changes from the existing ranked-market response.
2. Historical daily bars for Shanghai Composite, Shenzhen Component, ChiNext, and STAR 50.
3. Candidate-pool breadth by default. This pool is selected from several ranked lists and is **not** an unbiased full-market breadth sample.
4. If a qualified independent main-board universe scan was completed on the same Shanghai date within the last 10 minutes, that broader sample may replace the candidate-pool proxy. The scan is still not an exchange-certified atomic snapshot and does not cover every A-share board.

If index history is missing, the classifier falls back to current index returns and lowers its confidence cap. The UI displays the data-quality tier and the breadth source instead of implying a complete market snapshot.

## Scoring and risk controls

- Stage-one ranking weights and final factor weights change with market state.
- Final scores retain exhaustion, chase, and failed-breakout penalties.
- Strategy gates for minimum score, mainline, persistence, crowding, and failed-breakout penalty are state-specific.
- Position sizing uses whole 100-share lots, available-cash constraints, a 4.5%–7% ATR-derived stop distance, state-specific risk budget, and state-specific maximum position cap.
- Extreme-risk state blocks new entries.
- Holding review uses the last scan's market state and refuses to proceed when that state/ranked pool is stale; it applies the adaptive score and state-specific maximum holding horizon.
- The 27,000 CNY default is a **research sizing assumption** only. Users must enter current available brokerage cash and holdings manually. No brokerage connection or order placement exists.

## Validation

Run:

```bash
npm test
node --check api/market.js
```

CI also extracts and syntax-checks the V13 page's inline module.

Before considering production use, run point-in-time walk-forward tests with transaction fees, slippage, T+1, price limits, suspensions, gap risk, survivorship controls, and a separate result table for each market state. Do not tune these thresholds on the same period used to report performance. The forward panel uses only signals recorded in the current browser's local storage and fetches subsequent daily bars to mature 1/3/5-session outcomes. It is not a historical backtest; the sample is incomplete if browser data is cleared or if signals were not recorded. The current CI validates deterministic logic and syntax only; it does **not** establish profitability.
