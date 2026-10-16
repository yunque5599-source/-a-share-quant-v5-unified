# V11 Short Alpha — Phase 1

Branch: research/v11-short-alpha. Based on CORE commit aa03f5e.
Phase 1 adds a shared scoring record, Alpha calculation, and candidate-flow integration.
No production API, index.html, main, backtest, frontend, or deployment is changed.

## Unified scoring structure

Each candidate contains schema/modelVersion, asOf, symbol/name/industry/price,
marketRisk, source metadata, features, quality, scores, reasons, and rank.
features has capital, momentum, sector, volume, risk; each carries raw measurements
and a 0..100 score. scores.alpha is rounded for display; alphaRaw controls ranking
and decisions. components exposes weight and contribution. Missing scores contribute
zero with fixed weights and make quality incomplete; weights are never redistributed.

Alpha = capital*30% + momentum*25% + sector*20% + volume*15% + risk*10%.

Risk is a positive safety score. The earlier CORE risk penalty is not applied again.
Missing/degraded/stale evidence cannot produce a complete record.

## Factor definitions (research defaults)

- Capital: current main-net percentage (50%), signed-log net inflow strength (25%),
  positive-flow ratio over the last five matching kline sessions (25%).
- Momentum: close versus fifth-prior close (35%), tenth-prior close (35%),
  close relative to the prior twenty-session high, excluding current bar (30%).
- Sector: sector median percentage change (60%) and rank percentile (40%).
  Ranking is recalculated by descending median change, then industry name.
  At least two sectors are needed for a rank.
- Volume: provider f10 volume ratio or last/prior-five volume average (50%),
  last/prior-twenty volume average (50%). Expansion uses volume, not turnover.
- Risk safety: 20-return daily volatility (60%) and maximum peak-to-later-close
  drawdown in the last twenty closes (40%). Liquidity is a separate quality gate.

Momentum/sector percentage scores use clamp(50 + 5*pct); breakout uses
clamp(50 + 10*pct). Volume ratio and expansion use clamp(50 + 25*(ratio-1))
and clamp(50 + 35*(ratio-1)). Risk safety is clamp(100-10*volatility) and
clamp(100-4*drawdown). Parameters are transparent defaults, not validated alpha.

## Integration

Supply captured responses from the existing candidate workflow:

    { ranked: ranked_candidates_response,
      deep: deep_batch_response,
      discovery: discovery_universe_response,
      market: { marketRisk: "normal" } }

deep items are joined by code; callers collecting more than thirty candidates must
combine all deep_batch responses into one items array. No production API is called
or modified. Existing CORE data.candidates + historyBySymbol/flowBySymbol inputs
and enriched frontend arrays with k/f histories are also accepted.

An explicit snapshot asOf or ranked generatedAt bounds histories by Asia/Shanghai date.
Invalid/duplicate dates, incomplete factor windows, neutral/degraded flow, stale rank,
unqualified sector source, unfinished daily bar, ST/non-main-board candidates, missing
liquidity history or average turnover below 80 million CNY block completeness.
Risk limits are 15% maximum close drawdown or 8% daily volatility. No SELL rule is
introduced: CORE's normal-market TOP1>=90/TOP2>=85, 70/30 BUY, WATCH/WAIT policy
is reused without editing decision_output.js.

Quote timestamps are retained when available. Missing per-stock quote timestamps
are warned; this offline phase does not certify live synchronous freshness or fetch
exchange calendars. Prices must use consistent units/adjustment and captured source
times. Intraday partial bars must be marked barComplete=false. Kline session rows
are observations; official exchange-calendar gap certification is outside Phase 1.

## Run

Standalone JSON output:

    node research/v11-short-alpha/run.js --input research/v11-short-alpha/tests/fixtures/v11_flow.json

Existing CORE entry point, explicitly selecting V11:

    node research/v1040-core/run.js --model v11 --input research/v11-short-alpha/tests/fixtures/v11_flow.json

The default CORE model remains v1040. V11 does not persist/overwrite predictions.
Legacy CORE CLI may use --no-save to suppress its existing prediction write.

## Tests

    node --test research/v11-short-alpha/tests/v11_alpha_test.js
    node research/v1040-core/tests/decision_test.js
    node research/v1040-core/tests/real_data_test.js
    node research/v1040-core/tests/real006_factor_test.js

The fixture is synthetic and has real API shapes; test results do not prove investment
returns. T+1/3/5 backtests, SELL policy, production wiring, and frontend work are deferred.

## Alpha historical validation

The isolated validator replays captured Alpha rankings against future close bars:

    node research/v11-short-alpha/backtest/alpha_backtest.js \
      --input research/v11-short-alpha/tests/fixtures/alpha_backtest.json

The input may contain one result or a `predictions` array plus `histories`/ `historyBySymbol`.
T+1, T+3, and T+5 use the corresponding valid bar strictly after each snapshot
`asOf`; rows on or before `asOf`, malformed dates, duplicate dates, missing bars,
and incomplete Alpha records are never filled or counted as zero. Use
`includeIncomplete: true` only for diagnostic runs.

Each horizon returns observations, unavailable, averageReturnPct, winRatePct,
maxDrawdownPct, payoffRatio, and trade records. Maximum drawdown is calculated
from an equal-weight portfolio grouped by prediction date. Payoff ratio is average
winning return divided by the absolute average losing return; it is JSON `null`
when there are no losing observations. Optional round-trip costs are supplied as
`roundTripCostBps`. This is an offline research validator and does not change
the production page or API.

## Timing and overbought refinement

The Alpha weights remain capital 30%, momentum 25%, sector 20%, volume 15%, and
risk 10%. The momentum subscore now records `trendStage` (startup, acceleration,
mature, range, or high-risk), prior-five-day return, acceleration, and
`overboughtRisk`. High short-term return, extended ten-day return, or an extended
breakout applies a transparent penalty before the momentum contribution is ranked.

Capital now separates the prior five matching sessions from the latest five:
`early-inflow`, `recent-inflow`, `late-high-inflow`, and `outflow`. Positive
flows arriving while the price is already extended receive a timing penalty;
earlier accumulation receives a timing preference. Raw windows and penalties are
retained in the canonical feature record for review.

The synthetic comparison fixture is:

    research/v11-short-alpha/tests/fixtures/alpha_optimization_compare.json

It is only a deterministic regression sample for comparing the old ranking with
the refined ranking. It is not a live performance claim.

## Out-of-sample rolling validation

The rolling validator keeps Alpha weights fixed and separates captured snapshots into
training and future validation windows:

    node research/v11-short-alpha/backtest/rolling_backtest.js \
      --input research/v11-short-alpha/tests/fixtures/rolling_backtest.json

Defaults are two snapshots for training, one future snapshot for validation, and
one-step walk-forward advancement. Each fold reports Top1 and Top5 portfolios at
T+1, T+3, and T+5. Training profiles record the historical Alpha distribution and
fixed-weight configuration; they do not refit or alter the 30/25/20/15/10 weights.
Validation trades are passed only to the existing historical replay engine.

The aggregate output contains `tradeCount`, `winRatePct`, `averageReturnPct`,
`maxDrawdownPct`, and `payoffRatio` for each portfolio and horizon. The included
rolling fixture is synthetic and is intended to verify date separation, missing
windows, and metric aggregation rather than claim live performance.

## Buy Timing score

Buy Timing is an execution layer over the existing Alpha record. It does not change
Alpha weights or `scores.alpha`. Timing uses trend stage (40%), capital lead
(35%), and chase safety (25%) to produce `scores.timing` from 0 to 100. The
signals are `BUY_NOW` (75+), `WAIT_PULLBACK` (50-74), and `AVOID` (<50).
The composite trade score is `0.70 * Alpha + 0.30 * Timing`; missing timing
evidence yields a null composite instead of an optimistic fallback.

The historical replay keeps Alpha selection by default. To test timing-aware
execution explicitly, pass `selectionScore: "composite"` or:

    node research/v11-short-alpha/backtest/alpha_backtest.js \
      --selection-score composite --input FILE

Trade records retain Alpha, Timing, composite, and the selected score. Rolling
validation accepts the same selection option while preserving the fixed Alpha
weights. The timing fixture is
`research/v11-short-alpha/tests/fixtures/timing_backtest.json`.

## Composite stability benchmark

The benchmark compares three selectors on the same eligible snapshot universe:
deterministic seeded random selection, Alpha ranking, and explicit Alpha+Timing
composite ranking. It supports explicit date periods and reports Top1/Top5 at
T+1/T+3/T+5 for every period plus an aggregate:

    node research/v11-short-alpha/backtest/stability_benchmark.js \
      --input research/v11-short-alpha/tests/fixtures/stability_benchmark.json

Random selection is reproducible from the configured seed and snapshot date; it
does not use `Math.random` or any future close. Candidates are filtered by
as-of quality and score availability before all three selectors, and missing
composite scores never fall back to Alpha. The output reports
`tradeCount`, `winRatePct`, `averageReturnPct`, `maxDrawdownPct`,
`payoffRatio`, and unavailable counts for each strategy, period, portfolio,
and horizon. The expanded fixture is synthetic and is a validation regression,
not live-market performance evidence.

## V12 TradeScore backtest

V12 is evaluated as a separate research selector. The existing Composite remains
Alpha*0.70 + Timing*0.30; V12TradeScore is
Alpha*0.60 + Timing*0.25 + Psychology*0.15. Missing Psychology evidence never
falls back to Composite. The benchmark reports sample count, win rate, average
return, maximum drawdown, payoff ratio, and BUY_NOW accuracy for Top1/Top5 at
T+1/T+3/T+5 across explicit periods. BUY_NOW accuracy is the share of selected
BUY_NOW trades whose forward return is positive; it is null when there are no
BUY_NOW observations. This is research-only and does not alter production.

## V12 sample-out-of-sample validation, costs, and Market Regime

`research/v11-short-alpha/backtest/v12_oos.js` performs a chronological walk-forward
replay of V12TradeScore. A fold uses only the preceding `trainSize` snapshots as
the training window and scores the next `testSize` snapshots; fixed V12 weights
are not refit. The default fixture uses 18 dated snapshots, two-snapshot
training, two-snapshot validation, and a two-snapshot step (8 complete folds).
T+1, T+3, and T+5 are evaluated for Top1 and Top5.

`research/v11-short-alpha/market_regime.js` is a research-only grouping layer.
It returns `bull`, `bear`, `sideways`, or `unknown` with a score, confidence,
and feature diagnostics. It prefers an explicit as-of regime label, otherwise
uses index change/trend and market breadth. Historical market bars are filtered
to `asOf` before trend estimation, so bars after the prediction date cannot
change the label. The regime label is used only to partition validation metrics;
it is not an additional V12 factor and does not alter ranking.

Transaction costs are applied to the simulated execution prices:

- commission: 3 bps on buy and sell;
- stamp tax: 5 bps on sell only;
- slippage: 5 bps on each side.

Every completed trade retains `grossReturnPct`, `netReturnPct`, `commissionPct`,
`stampTaxPct`, `slippagePct`, and `totalCostPct`. Reports expose gross and net
metrics, including sample count, win rate, average return, maximum drawdown,
payoff ratio, and BUY_NOW accuracy. The bundled fixture is synthetic and checks
walk-forward separation, cost direction, and regime grouping; its numbers are
not a live-market performance claim.

Run it with:

    node research/v11-short-alpha/backtest/v12_oos.js \
      --input research/v11-short-alpha/tests/fixtures/v12_oos.json

\n
## V12 Market Regime execution gate

This execution policy preserves V12 factors, weights and TopN ranks. Bull permits
existing BUY_NOW. Neutral/sideways uses half exposure on every second chronological
neutral snapshot. Bear and unknown output WAIT with zero exposure. Missing asOf or
future-dated market timestamps fail closed to WAIT. Filtering never refills vacated
TopN slots. Training chronology is included when computing neutral cadence.

Baseline and gated arms share BUY_NOW eligibility, TopN slots, costs and a common
non-overlapping schedule; legacy all-signal replay is retained separately.
Missing forward prices are unavailable, not zero-return cash. Portfolio return is
exposure-weighted by TopN; trade win rate excludes cash. Zero trades report null
win rate and zero return/drawdown. Drawdown is endpoint cohort settlement equity,
not daily marked-to-market NAV. The fixture uses synthetic as-of labels.

    node research/v11-short-alpha/backtest/v12_regime_backtest.js \
      --input research/v11-short-alpha/tests/fixtures/v12_oos.json

Default costs are 3bps commission per side, 5bps sell stamp tax, and 5bps slippage
per side. Production page, API, and main are unchanged.

## V12 live snapshot capture

The capture workflow is intentionally separate from production and records a point-in-time artifact for forward validation.

The research branch includes a live capture CLI that runs the existing market, discovery, and
V12 psychology handlers from a reachable Node environment. It does not connect to a broker,
place orders, or modify production.

Run during a continuous A-share trading session:

    node research/v11-short-alpha/capture_v12_snapshot.js

Optional output path:

    node research/v11-short-alpha/capture_v12_snapshot.js ./my-snapshot.json

The capture:

1. obtains the current ranked candidate universe;
2. selects the first 30 eligible 00/60 main-board candidates;
3. fetches deep kline/flow data for those candidates;
4. fetches the independent discovery universe;
5. fetches V12 theme membership, theme flow, leader, and dated news evidence;
6. runs integrateCandidateFlow with the captured V12 psychology context;
7. writes an immutable, dated JSON snapshot containing the raw inputs, model versions,
   as-of timestamp, diagnostics, and Top20 V12 trade ranking.

A same-day snapshot must not be edited after capture. Forward T+1/T+3/T+5 outcomes are
measured only after the corresponding future bars exist. The snapshot itself is evidence
of what the model knew at capture time, not evidence of profitability.

### Live source probe

live_source_probe.js and .github/workflows/v12-live-source-probe.yml provide a
non-production connectivity check. The probe is informational and is allowed to fail
without making the deterministic research suite fail.

At present, GitHub-hosted runners may receive HTTP 502/fetch failures from Eastmoney.
That result is treated as an environment/upstream connectivity limitation, not as proof
that the local live capture path works. A real capture must therefore be run from an
environment that can actually reach the upstream sources.

### Live-money validation boundary

The research system deliberately stops before brokerage execution. Actual money, if used
for validation, must be tied to a previously captured signal snapshot and recorded with
the real order/fill timestamp, quantity, price, fees, slippage, rejection/cancellation
status, and exit details. No same-day outcome may be fed back into that day's signal.
\n

### Forward-outcome evaluation

After a snapshot is captured, do not edit the snapshot. Once future trading-day bars exist,
run:

    node research/v11-short-alpha/evaluate_v12_snapshot.js ./live_snapshots/v12-YYYYMMDD-HHMM.json

The evaluator re-fetches current historical daily bars, then strictly excludes every bar whose
date is on or before the snapshot as-of date. It reports T+1/T+3/T+5 close returns, 5-day
maximum favorable/adverse excursion, win/loss rates, and Top1/Top5/Top10/Top20 summaries.

This is a research measurement, not a broker-fill simulation. Entry price is the snapshot
decision price; fees, slippage, queue position, suspension, limit-up/limit-down execution,
and actual fill probability are not inferred. Actual-money validation uses a separate execution
ledger and the real fill price.


## V12 Short-Horizon Selection Validation

V12 selection research is centered on cross-sectional stock selection for the next
one to five trading sessions. It preserves the frozen Alpha 60%, Timing 25%, and
Psychology 15% baseline and exposes the compatible V12SelectionScore; it does
not introduce a new factor or change weights.

`evaluate_v12_snapshot.js` evaluates every available
`decision.datasetCandidates` row, with legacy `tradeRanking` fallback. It
records T+1 through T+5 absolute returns, market and sector excess returns when
point-in-time benchmark histories are supplied, per-horizon MFE/MAE, win/loss,
`horizonProfile`, `bestHorizon`, and a diagnostic short-horizon pattern.
Future bars require a trading date strictly after the Asia/Shanghai snapshot date.
Missing benchmark, high, or low data remains `null`.

`analyze_v12_selection.js` reports per-horizon Rank IC, Spearman correlation,
Top 5/10/20% versus Bottom 20% spreads, win rate, MFE, MAE, and absolute/market/
sector excess returns. It also splits results by Bull/Neutral/Bear, market emotion
High/Normal/Low, and 11:15/13:30/14:45 snapshot buckets. Per-snapshot quantile
cuts prevent mixing ranks across dates. These are validation statistics only; ML
does not change the rule model.

Live snapshot capture retains legacy Top20 `tradeRanking` and now stores the full
`decision.datasetCandidates` for future selection validation. No production page,
API, broker, automatic order placement, or training-data mixing is changed.
