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
