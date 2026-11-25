# V16 market-state and overnight-impact research layer

This is an isolated research layer. It does not modify production `index.html`, `api/market.js`, production weights, deployment, broker integration, or order execution.

## Modules
- `market_transition.js`: weighted market breadth/index/turnover/sentiment/sector/leader score; BEAR, TRANSITION, BULL and DISTRIBUTION classification. BULL/BEAR require multi-session confirmation.
- `overnight_global_impact.js`: separate US semiconductor, AI-infrastructure, mega-cap, memory and cloud factors; explicit A-share industry exposure map; opening confirmation is NOT_MEASURABLE without first-15-minute/VWAP inputs.
- `sector_rotation.js`: sector persistence, rotation acceleration, prior-day profit-taking risk, LHB sector breadth, and independent entry-timing score.
- `volume_price_phase.js`: classifies early daily breakout, constructive low-volume pullback, post-pullback reacceleration, tight consolidation, acceleration risk and distribution risk from point-in-time daily OHLCV. It exposes a separate research adjustment but keeps `mainScoreAdjustment=0` and `usedForSelection=false` until cohort validation.
- `volume_price_phase_backtest.js`: compares next-session outcomes of the phase groups on the reconstructed V15 Stage1 Top50; requires complete daily-bar candidate coverage, at least 20 matured signal dates and 95% matched outcomes per group. It is descriptive, not calibrated.
- `limit_up_quality.js`: separates Eastmoney post-close daily-pool proxies from minute-bar seal quality, Level-2 order-book cancellation risk, and next-session first-15-minute follow-through. It reports first-seal timing/reopen-count categories as uncalibrated observation-only diagnostics; intraday, cancellation and next-session states remain NOT_MEASURABLE until timestamped feeds with coverage checks are supplied.
- `limit_up_quality_backtest.js`: chronological cohort replay of signal-date stable/mixed/risky daily-proxy groups and broken-board pool members against next-session open/close outcomes. It requires full-market replay-qualified snapshots, adjacent weekday sessions, at least 20 matured signal dates and 95% outcome coverage per cohort; future prices are labels only.
- `flow_lhb.js`: normalizes Eastmoney limit-up/broken-board/limit-down pools and post-close LHB daily/seat disclosures; deduplicates repeated abnormal-trading rows; computes board ladder, broken-board rate, institution-labelled seat flow, next-session limit-up cohort premium, and 2-of-3-session capital-flow persistence. Funding evidence only raises research attention when three consecutive qualified snapshots show at least two positive main-flow observations and higher lows; incomplete three-session inputs remain NOT_MEASURABLE. High-turnover price extension is penalized, and missing chase-risk inputs are not represented as zero risk. Full-market rows are used when a candidate is outside the top-500 funding display subset.
- `decision_overlay.js`: combines market, sector, overnight and entry gates. It never places orders.
- `narrative_theme.js`: lexical name-theme detection for 羊／洋／阳、狼 and 东方; computes heat, diffusion, turnover concentration and multi-session exhaustion risk. It does not infer a fundamental catalyst from a name.
- `narrative_theme_case_study_2026-11-03_06.md`: documents the Nov 3–6 public event reports and explicitly separates event description from predictive backtest evidence.
- `replay.js`: chronological point-in-time market/narrative replay and Nov 4–5 validation status; future snapshots are excluded.
- `selection_backtest.js`: deterministic reconstruction of the V15 six-factor rank pool and stage-one score, plus baseline Top10/30/50 T+1/T+3/T+5 forward-return evaluation.
- `flow_lhb_backtest.js`: point-in-time factor ablation comparing baseline, +10% main-force net-flow persistence, +5% post-close LHB, and combined ranking. The funding ablation deliberately excludes institutional LHB inputs so the funding and LHB variants are independent and do not double-count the same disclosure. It reports daily Top10/30/50 selections, next-session-open-to-T+1/T+3/T+5-close returns, win rate, excess return, drawdown, MFE/MAE, exact eligible main-board vendor limit-up event capture, and factor/source coverage. Future outcome data is excluded from signal ranking; funding inputs require three consecutive qualified snapshots.
- `snapshot_archive.js`: normalizes full-market daily rows and enforces close-finalization, universe coverage and quote-date quality gates before a snapshot can qualify for replay.
- `api/v16_market_context.js`: separate research endpoint for Eastmoney A-share index/universe data, limit-up/broken-board/limit-down pools, post-close LHB daily and seat disclosures, and date-filtered Yahoo US daily returns. It returns normalized full-market stock rows for server-side archiving; LHB and limit-pool failures remain explicit PARTIAL/NOT_MEASURABLE states.
- `api/v16_snapshot_archive.js`: authenticated manual post-close collector for controlled diagnostics. It requires `CRON_SECRET` and writes only to the connected private Blob store.
- `api/v16_snapshot_archive_schedule.js`: private Vercel Schedules function using `handleSchedule`; it has no public URL and can only be invoked by Vercel's scheduler. It shares the same collection/write path as the manual endpoint and does not depend on `CRON_SECRET`.
- `archive_runner.js`: shared close/trading-day guards, gzip serialization and private immutable Blob write contract used by both archive entry points.
- `api/v16_backtest.js`: reads private archived snapshots and returns both the reconstructed V15 Stage-1 baseline report and the flow/LHB factor-ablation report. Its archive window is selected by unique trading dates, applies `asOf` before slicing, and counts missing or unreadable snapshot files as read failures.
- `vercel.json`: declares the private `v16-snapshot-archive` schedule for 20:10 Asia/Shanghai, Monday to Friday, targeting `api/v16_snapshot_archive_schedule`. The Preview-branch schedule is registered on deploy but starts inactive; it must be enabled for the research branch in the Vercel Schedules dashboard. No Production deployment or schedule is activated by this PR.
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

## Volume-price phase model
- After the close, the archive collector requests up to 100 unadjusted daily bars (`fqt=0`) for the reconstructed V15 Stage1 Top50, then labels each candidate as EARLY_BREAKOUT, CONSTRUCTIVE_PULLBACK, REACCELERATION, TIGHT_CONSOLIDATION, ACCELERATION_RISK, DISTRIBUTION_RISK or NEUTRAL.
- Constructive pullback requires a recent price impulse, a bounded retracement, lower volume on declining sessions and support retention. Reacceleration additionally requires a stronger close above the prior day's high with renewed volume. A high-volume decline, weak close or support break is kept separate as distribution risk.
- Raw unadjusted daily bars and point-in-time phase labels are archived for reproducibility. The daily K-line collection is limited to V15 Stage1 Top50; it is not a full-market V16 scan. Missing or stale K-lines remain NOT_MEASURABLE/PARTIAL.
- The phase model emits a research-only score adjustment for comparison. It does not alter core V16 weights, candidate ordering, buy-plan eligibility or production behavior until out-of-sample cohort validation passes.

## Limit-up quality model
- The daily vendor proxy is kept separate from exact intraday seal quality. Its provisional diagnostic uses only reported first-seal time, reported reopen count and explicitly full-market breadth; turnover and multi-board extension are risk flags, not hidden positive factors.
- `PROXY_STABLE`, `PROXY_MIXED` and `PROXY_RISKY` are heuristic cohort labels, not calibrated probabilities. They do not alter V16 core weights, candidate rank, buy-plan eligibility or production behavior.
- Minute-bar seal duration/reopen analysis requires at least 95% timestamped session coverage. Order-book cancellation risk requires complete Level-2 add/cancel/execute event totals. Next-session follow-through requires auction open, complete first-15-minute OHLC/VWAP, and contemporaneous market/industry first-15-minute returns.
- Next-session follow-through is an after-open confirmation diagnostic, not a signal known at the prior close. Historical cohort replay uses next-session outcomes only as labels and never as signal features.

## Data capability gates
| Metric | Required evidence | Missing-data treatment |
|---|---|---|
| Full-market breadth | All expected pages fetched and at least 99% unique-code coverage | Otherwise labelled partial-market; not full-market |
| US overnight factors | Yahoo daily bars dated strictly before China calendar date | Missing symbols reduce factor coverage; same-date US bars excluded |
| Limit-up daily quality proxy | Complete vendor limit-up pool with first-seal time and reported reopen count | Partial/unavailable; uncalibrated proxy only |
| Intraday seal quality | Timestamped minute bars with at least 95% session coverage | NOT_MEASURABLE |
| Order-book cancellation risk | Complete Level-2 bid add/cancel/execute event coverage | NOT_MEASURABLE |
| Next-session follow-through | Next-session auction, first 15-minute OHLC/VWAP, market and sector context | NOT_MEASURABLE until after open |
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
- Limit-up quality cohort replay groups stocks using only signal-date vendor-pool fields and measures next-session open-to-close, gap, MFE/MAE and close-to-close outcomes. It is descriptive until each cohort has at least 20 matured signal dates and 95% matched outcomes.
- The new flow/LHB ablation uses post-close signal data and assumes the earliest modeled entry is the next trading session open. T+1/T+3/T+5 returns are measured from that open to the corresponding future close. This avoids granting the strategy a same-close fill after post-close LHB disclosures.
- Exact future limit-up capture uses the Eastmoney vendor event pool, not the old 9.5% return proxy. The event source remains vendor data, not exchange-certified order-book evidence.
- The ablation variants are baseline, baseline + 10% main-force net-flow persistence, baseline + 5% LHB percentile, and combined 85% baseline + 10% main-flow + 5% LHB. Institutional LHB is excluded from the funding ablation to avoid double-counting it in the separate LHB variant. Complete three-session funding inputs with no confirmed persistence score 0; incomplete funding inputs leave the baseline score unchanged. Missing LHB feeds are not imputed; no LHB disclosure is neutral only when the daily LHB feed and stock-signal map are both complete.
- At least 20 matured signal dates and at least 95% selected-candidate outcome coverage are required before a return metric is labelled MEASURABLE. Exact limit-up capture has a separate coverage status and also requires at least 95% of signal dates with complete vendor pools. The report remains promotion-ineligible until out-of-sample stability and execution-aware validation pass.
- Evaluate final model Top-K precision/recall, T+1/T+3/T+5 returns, MFE/MAE, fees, slippage, T+1 sellability, limit locks and fill constraints against untouched momentum/breakout baselines.
- This branch is research-only. No production merge/deployment until point-in-time validation passes and the user explicitly approves promotion.

## Archive setup and operation
- The post-close archive job fetches unadjusted daily K-lines for up to 50 V15 Stage1 candidates and, for the V17 shadow selector, up to 30 additional candidates from a Shanghai/Shenzhen-supported early-flow prefilter (codes beginning 0, 3 and 6; Beijing code families are not yet supported). The V17 funnel is the union of these two pools, not a full-market 65-bar scan. These bars are archived only by the private archive route; K-line coverage remains separate from full-market snapshot qualification.
1. Connect a **private** Vercel Blob store to the project. Private Blob requires authenticated access; do not use a public store for research snapshots.
2. Keep `BLOB_READ_WRITE_TOKEN` scoped to Preview. The manual `/api/v16_snapshot_archive` diagnostic endpoint also requires a random `CRON_SECRET` scoped to Preview; the private scheduled function does not use that shared-secret endpoint.
3. Deploy the research branch as a Preview deployment. Vercel registers `v16-snapshot-archive` for that Preview branch in the Schedules tab; new Preview schedules start inactive.
4. In Vercel Dashboard → Project → Schedules, select Preview branch `research/v16-flow-lhb-20261118`, enable `v16-snapshot-archive`, and invoke it once to validate the first archive run. The recurring time is 20:10 Asia/Shanghai, Monday to Friday. Do not enable the Production schedule during research.
5. The collector skips non-trading days and pre-close calls. It archives incomplete snapshots for diagnostics, but the backtest only uses snapshots that pass the strict quality gate.
6. Snapshot files are gzip-compressed and immutable. The backtest API reads the latest archive window and reports data gaps rather than filling missing outcomes with zero. The factor-ablation report requires at least three qualified sessions for funding evidence and at least 20 matured signal dates before any Top-K/horizon is labelled MEASURABLE.

## Tests
Run syntax checks on all V16 modules and API routes, then `node --test tests/v16_market_system.test.js tests/v16_market_context.test.js tests/v16_narrative_theme.test.js tests/v16_selection_backtest.test.js tests/v16_snapshot_archive.test.js tests/v16_flow_lhb.test.js tests/v16_flow_lhb_integration.test.js tests/v16_flow_lhb_backtest.test.js tests/v16_early_trend.test.js tests/v16_limit_up_quality.test.js tests/v16_limit_up_quality_backtest.test.js tests/v16_volume_price_phase.test.js tests/v16_volume_price_phase_backtest.test.js`.