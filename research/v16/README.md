# V16 market-state and overnight-impact research layer

This is an isolated research layer. It does not modify production `index.html`, `api/market.js`, production weights, deployment, broker integration, or order execution.

## Modules
- `market_transition.js`: weighted market breadth/index/turnover/sentiment/sector/leader score; BEAR, TRANSITION, BULL and DISTRIBUTION classification. BULL/BEAR require multi-session confirmation.
- `overnight_global_impact.js`: separate US semiconductor, AI-infrastructure, mega-cap, memory and cloud factors; explicit A-share industry exposure map; opening confirmation is NOT_MEASURABLE without first-15-minute/VWAP inputs.
- `sector_rotation.js`: sector persistence, rotation acceleration, prior-day profit-taking risk, LHB sector breadth, and independent entry-timing score.
- `flow_lhb.js`: normalizes Eastmoney limit-up/broken-board/limit-down pools and post-close LHB daily/seat disclosures; deduplicates repeated abnormal-trading rows; computes board ladder, broken-board rate, institution-labelled seat flow, next-session limit-up cohort premium, and 2-of-3-session capital-flow persistence. Funding evidence only raises research attention when higher lows confirm; high-turnover price extension is penalized. Full-market rows are used when a candidate is outside the top-500 funding display subset.
- `decision_overlay.js`: combines market, sector, overnight and entry gates. It never places orders.
- `narrative_theme.js`: lexical name-theme detection for 羊／洋／阳、狼 and 东方; computes heat, diffusion, turnover concentration and multi-session exhaustion risk. It does not infer a fundamental catalyst from a name.
- `narrative_theme_case_study_2026-11-03_06.md`: documents the Nov 3–6 public event reports and explicitly separates event description from predictive backtest evidence.
- `replay.js`: chronological point-in-time market/narrative replay and Nov 4–5 validation status; future snapshots are excluded.
- `selection_backtest.js`: deterministic reconstruction of the V15 six-factor rank pool and stage-one score, plus baseline Top10/30/50 T+1/T+3/T+5 forward-return evaluation.
- `flow_lhb_backtest.js`: point-in-time factor ablation comparing baseline, +10% persistent funding, +5% post-close LHB, and combined ranking. It reports daily Top10/30/50 selections, next-session-open-to-T+1/T+3/T+5-close returns, win rate, excess return, drawdown, MFE/MAE, exact vendor limit-up event capture, and factor/source coverage. Future outcome data is excluded from signal ranking.
- `snapshot_archive.js`: normalizes full-market daily rows and enforces close-finalization, universe coverage and quote-date quality gates before a snapshot can qualify for replay.
- `api/v16_market_context.js`: separate research endpoint for Eastmoney A-share index/universe data, limit-up/broken-board/limit-down pools, post-close LHB daily and seat disclosures, and date-filtered Yahoo US daily returns. It returns normalized full-market stock rows for server-side archiving; LHB and limit-pool failures remain explicit PARTIAL/NOT_MEASURABLE states.
- `api/v16_snapshot_archive.js`: authenticated post-close collector that writes immutable gzip snapshots to a private Vercel Blob store. It requires `CRON_SECRET` and a connected private Blob store.
- `api/v16_backtest.js`: reads private archived snapshots and returns both the reconstructed V15 Stage-1 baseline report and the flow/LHB factor-ablation report.
- `vercel.json`: schedules the archive endpoint at 12:10 UTC (20:10 China time), Monday to Friday, so post-close LHB disclosures have time to arrive. Vercel Cron only runs on production deployments; this research PR does not activate it.
- `index_V16_MARKET_SHADOW.html`: standalone browser dashboard. It stores up to 30 local snapshots and displays limit-up ladder, LHB daily/seat flow, and a main-board funding-persistence watchlist. The watchlist is restricted to the top 500 main-board rows by absolute daily main-force flow and is not a full-universe final selection; the server Top-K backtest panel requires private archive storage.

## Score conventions
- Scores are 0–100; 50 is neutral. Daily returns use percentage points (e.g. -1.5 means -1.5%).
- Breadth ratios accept decimals or percentages. Full-market breadth must be explicitly labelled `universe: 'full-market'`; candidate-pool breadth is downgraded and warned.
- Initial market weights: breadth 25%, index trend 20%, turnover 15%, sentiment 15%, sector persistence 15%, leader health 10%. Missing components are excluded and confidence falls; missing values are never filled with neutral scores.
- `market_transition_score` is a change diagnostic, not a probability. `market_reversal_risk` is a risk diagnostic, not a forecast.
- US/industry impact scores use 0–100 with 50 neutral. Industry sensitivities are separate assumptions, not one universal technology coefficient.
- `policy_event_risk` only uses verified events with a source URL, severity and direction. Without them it is NOT_MEASURABLE.
- `opportunity_score` and `entry_timing_score` are independent. High opportunity does not authorize a buy.
- Narrative `name_theme_heat_score` contributes only to a separate `attention_priority_score`; it never increases `opportunity_score` or independently authorizes entry. A measured `speculative_exhaustion_risk` of 75 or higher blocks a name-theme candidate in the decision overlay.
- `leader_concentration` is the largest member's share of theme turnover amount, not an ownership statistic. Diffusion requires two comparable full-market snapshots; exhaustion requires at least three full-market snapshots and a common constituent cohort.
- `fundamental_overlap_score` remains null unless a dated, verified source URL and explicit theme/stock mapping are provided. The upstream caller is responsible for setting `verified: true` only after source verification. Name similarity is not an earnings or industry catalyst.

## Data capability gates
| Metric | Required evidence | Missing-data treatment |
|---|---|---|
| Full-market breadth | All expected pages fetched and at least 99% unique-code coverage | Otherwise labelled partial-market; not full-market |
| US overnight factors | Yahoo daily bars dated strictly before China calendar date | Missing symbols reduce factor coverage; same-date US bars excluded |
| Exact limit-up/down | Eastmoney limit-up/broken-board/limit-down event pools | Vendor pool status and source diagnostics retained; do not relabel as exchange-certified |
| Limit-up ladder | Daily limit-up pool with `lbc` board count | Missing pool remains NOT_MEASURABLE; no percent-threshold substitution |
| LHB daily/seat flow | Date-filtered DataCenter disclosures, deduplicated by stock/seat | Missing or delayed report remains NOT_MEASURABLE; only explicit institution-labelled seats count as institutional |
| Funding persistence | Up to three point-in-time stock-flow snapshots plus daily lows | Requires at least two positive-flow sessions and higher lows; single-day inflow is not a bottom signal |
| Next-day limit-up premium | Prior-session limit-up cohort matched to current full-market rows | Requires at least 80% matched cohort coverage; otherwise NOT_MEASURABLE |
| Broken-board rate | Eastmoney broken-board pool divided by sealed plus broken pools | Vendor-pool proxy only; intraday touch/reopen sequence and order-book proof remain NOT_MEASURABLE |
| Next-day premium | Frozen signal-date list and matured next-session outcomes | NOT_MEASURABLE until matured |
| Auction/first 15m/VWAP | Timestamped minute bars and sector/leader observations | NOT_MEASURABLE; daily close is not a substitute |
| Policy/event risk | Verified event with source URL, timestamp, direction and severity | NOT_MEASURABLE |
| Name-theme membership | Exact stock-name token match for 羊／洋／阳, 狼 and 东方 | `LEXICAL_MATCH_ONLY`; not verified industry membership |
| Industry/concept theme membership | Verified point-in-time concept constituents | NOT_MEASURABLE until constituent data is supplied |
| Name-theme heat | Current full-universe names, returns and turnover amounts | Partial if universe coverage is incomplete |
| Theme diffusion | At least two comparable full-market snapshots with stable name/code observations | NOT_MEASURABLE without comparable full-market history |
| Speculative exhaustion | At least three full-market snapshots and a common constituent cohort | NOT_MEASURABLE without full-market history |
| Fundamental overlap | Dated verified source URL plus explicit stock/theme mapping | NOT_MEASURABLE; never infer from name alone |

## Replay and promotion
- Replay only frozen snapshots captured on or before the requested cutoff.
- Never use same-day close to reconstruct auction, first-15-minute, VWAP or order-book decisions.
- The original Top10/30/50 backtest reconstructs the V15 six-factor rank pool and Stage-1 formula from full-market snapshots. It is a **preselection-funnel test**, not the final deep K-line/flow/news ranking.
- The new flow/LHB ablation uses post-close signal data and assumes the earliest modeled entry is the next trading session open. T+1/T+3/T+5 returns are measured from that open to the corresponding future close. This avoids granting the strategy a same-close fill after post-close LHB disclosures.
- Exact future limit-up capture uses the Eastmoney vendor event pool, not the old 9.5% return proxy. The event source remains vendor data, not exchange-certified order-book evidence.
- The ablation variants are baseline, baseline + 10% persistent funding, baseline + 5% LHB percentile, and combined 85% baseline + 10% funding + 5% LHB. Missing feeds are not imputed; a missing factor leaves the baseline score unchanged. No LHB disclosure is neutral only when the daily LHB feed is complete.
- At least 20 matured signal dates are required before each Top-K/horizon metric is labelled MEASURABLE. The report remains promotion-ineligible until out-of-sample stability and execution-aware validation pass.
- Evaluate final model Top-K precision/recall, T+1/T+3/T+5 returns, MFE/MAE, fees, slippage, T+1 sellability, limit locks and fill constraints against untouched momentum/breakout baselines.
- This branch is research-only. No production merge/deployment until point-in-time validation passes and the user explicitly approves promotion.

## Archive setup and operation
1. Connect a **private** Vercel Blob store to the project. Private Blob requires authenticated access; do not use a public store for research snapshots.
2. Configure a random `CRON_SECRET` in the Vercel project Production environment. The archive endpoint rejects requests when it is absent or invalid.
3. Merge/deploy only after review. The cron schedule is 08:20 UTC / 16:20 China time on weekdays; Vercel Cron runs only on production deployments, not preview deployments.
4. The collector skips non-trading days and pre-close calls. It archives incomplete snapshots for diagnostics, but the backtest only uses snapshots that pass the strict quality gate.
5. Snapshot files are gzip-compressed and immutable. The backtest API reads the latest archive window and reports data gaps rather than filling missing outcomes with zero.

## Tests
Run syntax checks on all V16 modules and API routes, then `node --test tests/v16_market_system.test.js tests/v16_market_context.test.js tests/v16_narrative_theme.test.js tests/v16_selection_backtest.test.js tests/v16_snapshot_archive.test.js tests/v16_flow_lhb.test.js tests/v16_flow_lhb_integration.test.js tests/v16_flow_lhb_backtest.test.js`.