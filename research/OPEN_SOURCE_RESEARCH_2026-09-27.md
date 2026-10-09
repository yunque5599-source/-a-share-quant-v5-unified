# V10.3.8 open-source research intake (2026-09-27)

Scope: this document studies open-source engineering patterns for **an A-share, main-board, short-horizon, manually executed strategy**. It is a research intake, not a performance claim, code import, production promotion, or financial advice. The repository's production `index.html` and `api/market.js` remain unchanged.

## Verified upstream repositories and what to adopt

| Source | Upstream | Module or idea relevant here | Adoption rule |
|---|---|---|---|
| Qlib | https://github.com/microsoft/qlib | Point-in-time dataset creation, time-split evaluation, factor/model/portfolio separation | Read the design first. Reproduce on frozen A-share evidence, not current constituent lists or retrospectively chosen winners. |
| AKShare | https://github.com/akfamily/akshare | Data adapters, historical price and symbol metadata interfaces | Prototype as an **independent cross-check** only. Check source provenance, exchange segment, timestamp, corporate actions, and provider/API terms. No implicit fallback to trading signals. |
| RQAlpha | https://github.com/ricequant/rqalpha | Event-driven account and fill accounting, A-share trading constraints | Research accounting behavior. Its README specifies non-commercial use; inspect license/terms before copying or incorporating code. |
| QuantStats | https://github.com/ranaroussi/quantstats | Equity-curve statistics, drawdown and risk reporting | Use only after actual continuous equity series exists; never feed selected-stock future returns as portfolio returns. |
| RD-Agent | https://github.com/microsoft/RD-Agent | Automated factor and model experimentation | Defer until frozen data, leakage tests, independent baselines and out-of-sample evaluation are available. Every proposed change needs a separate reproducible experiment. |
| FinRL | https://github.com/AI4Finance-Foundation/FinRL | RL market simulator, transaction costs, comparison baselines | Research candidate for a later stage, **not** evidence it can identify A-share limit-up stocks. Initial framework README now points to FinRL-X for the newer stack. |
| VeighNa | https://github.com/vnpy/vnpy | Data/event/strategy/risk-execution layer boundaries | Architecture reference, not a direct import into the browser-only production UI. |

GitHub stars, demonstration returns and papers are not measured net performance on this user's account or data. Repository popularity is not an adoption criterion. Do not lift implementation code without checking licenses and provenance.

## Baseline before algorithmic sophistication

1. **Frozen as-of evidence**: original provider response bytes, SHA-256, actual observation time, response date and cache age, workflow commit SHA. The current ranked-candidate endpoint is a *capped multi-list preselection*, not an exchange-certified complete roster and not the browser's actual BUY/WAIT.
2. **Strict data status**: QUOTE_STALE, RANK_PARTIAL, SOURCE_FAILED, AFTER_HOURS and SIGNAL_NOT_CAPTURED must remain distinct. HTTP 200 and recently generated JSON do not demonstrate recent stock quotes. Market holidays require a proper exchange calendar.
3. **Original signal log**: when available, capture version, time, full candidate inputs, execution gate, BUY/WAIT, plan price/size/stop, cash and sellable inventory. Candidate ranks cannot stand in for a model signal.
4. **Paired trading engine**: use same time-indexed universe and execution assumptions for V10 and simple 1-day/3-day momentum. Observe 100-share lots, T+1 sellability, cash, suspended stocks, split/dividend adjustment, unfillable limit-ups, fees, slippage and available order-book evidence. Any missing fill evidence should be flagged, never silently assumed successful.
5. **Metrics**: continuous net portfolio return and max drawdown first; turnover, exposure, rejected orders, data-source coverage and trade-level P&L. Limit-up recall, ranking accuracy and model Sharpe are supporting measures only. Include zero-trade/WAIT days.
6. **Promotion gate**: forward periods and unseen regimes; do not tune on a final evaluation window. Predeclare costs, baselines and failure thresholds before research. Require evidence beyond hindsight four-stock proxies before changing `main` or Vercel production.

## Current status and immediate experiment

- `source-probe.yml` on the prior run: only 5/10 data-source checks passed. Four-page contiguous Eastmoney sampling failed partway through, so provider availability is not solved merely by changing compute host.
- `quote-batch-probe.yml` on the new fork: 9/9 checks of 2/10/20 stocks passed, but tested weekend snapshots around 170,000 seconds old. This establishes sample parsing/transport, not intraday freshness or complete coverage.
- The new manual `forward-evidence.yml` captures only the source ranking JSON and manifest. Its `rawRankArchiveComplete` means the returned *ranking archive* passed explicit structure checks. It never qualifies for trading or the historical original-V10 P&L calculation.
- Next independent experiments: exchange-calibrated roster verification; 50/100 distinct-code batch and trading-session timestamp tests; capture immutable **real** in-browser model decisions; only then replay a continuous 80,000-yuan research account with actual available cash distinguished from hypothetical model capital.

No trading, automatic buy/sell, production deployment, or model-weight change is authorized by this document.
