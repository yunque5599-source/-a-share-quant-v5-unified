# V10.4.1 Short Alpha

Research code on branch research/v10.4.1-short-alpha, based on V10.4.0 CORE commit
aa03f5e. These modules do not change CORE entry rules, main, production APIs, or deployment.
The fixture is synthetic and proves calculation behavior, not investment performance.

## Forward return replay

Import replayForwardReturns from forward_return_replay.js. Input:

    {
      sessions: ["2026-03-06", "2026-03-09", "..."],
      predictions: [{ date: "2026-03-06", symbol: "AAA", score: 94 }],
      prices: { AAA: [{ date: "2026-03-06", close: 100 }, "..."] },
      horizons: [1, 5, 20],
      asOf: "2026-04-03",
      costBps: 10
    }

sessions is the caller-supplied complete exchange calendar. Offsets use calendar indices,
so weekends, holidays, suspensions, and missing quotes do not move the target session.
Dates must be real YYYY-MM-DD dates; duplicate calendar dates are rejected. Quote order
does not matter. Conflicting duplicate quote dates are unavailable. CORE saved prediction
documents with a predictions array and Eastmoney kline.data.klines envelopes are supported.
observations.sessions/prices can also supply the calendar and histories.

The entry reference is the positive explicit entryPrice, or the signal-date close.
Later quotes never fill a missing entry. Invalid explicit prices are not silently replaced.
asOf bounds observations; it defaults to the last supplied calendar date. Future targets,
missing entry/target prices, or insufficient calendar coverage produce PENDING.
The first date/symbol prediction wins; duplicates are diagnosed.

This is a close-reference event study, not an executable trade or portfolio backtest.
A closing signal does not guarantee a fill at that close. All closes must use one consistent
adjustment basis; the module does not adjust corporate actions. Trading restrictions,
slippage, price limits, and portfolio overlap are not modeled by this return measurement.

Per-side costBps is configurable (default 0). Net return is:
target * (1-costBps/10000) / (entry * (1+costBps/10000)) - 1.
Reported percentages include gross/net returns and cost drag. Fees/taxes/slippage may be
included in the supplied symmetric cost estimate; their separate components are not modeled.

Win rate and mean include only completed endpoint returns; pending is not a loss.
A missing intermediate quote still permits endpoint return but makes path metrics null.
Drawdown is peak-to-later-close over entry plus the complete daily close path.
MFE/MAE are close-reference excursions (not intraday high/low); MAE is zero or negative.
Aggregated drawdown is the worst single-event path, not strategy equity drawdown.
Statistics report a separate pathEvaluated count.

## Exit score

Import calculateExitScore(position, market, options) from exit_score.js. Required snapshot:

    {
      entryPrice: 100, currentPrice: 102, peakPrice: 102, daysHeld: 1,
      trendBreak: false, flowWeakening: false, liquidityStress: false,
      marketRisk: "normal"
    }

daysHeld is the number of exchange sessions since purchase (0 on purchase day).
Missing core prices, session age, evidence flags, unknown market risk, or inconsistent
date/price evidence produce WAIT with missingFields/reasons. Boolean false is observed
negative evidence; an omitted flag is unknown.

Default score components: drawdown 8/20/35 points for positive/at-least-4%/at-least-8%
drawdown; trend break 25; elevated/weak market 12/25; weakening flow 15; unrealized
profit at least 10%/20% adds 8/15; holding at least 10/20 sessions adds 5/10;
liquidity stress 10. The score is capped at 100.

Research defaults (exported as EXIT_DEFAULTS) are EXIT >=70 and TRIM >=45,
otherwise HOLD. Stop loss <=-5%, trailing drawdown >=8%, or holding >=20 sessions
force an EXIT recommendation. Thresholds are configurable and have not been optimized.
A-share T+1 prevents same-session EXIT/TRIM: action becomes WAIT, canSell=false,
and recommendation/reasons preserve the exit pressure. Scores are advice, not orders.

evaluateExitAtDate({position, bars, sessions, asOfDate, market}, options) derives price,
peak and holding age only through asOfDate; future bars cannot change earlier advice.
Evidence flags must refer to that snapshot. Missing path prices produce WAIT.
Optional snapshotDate must not be later than asOfDate.

## Run and tests

From the repository root:

    node --test research/v10.4.1-short-alpha/tests/short_alpha_test.js
    node research/v10.4.1-short-alpha/run.js --input research/v10.4.1-short-alpha/tests/fixtures/short_alpha.json

Optional --output NEW_FILE writes a report exclusively; an existing file is never replaced.
Without --output the CLI only prints JSON. Importing modules causes no file writes/network calls.

CORE regression checks:

    node research/v1040-core/tests/decision_test.js
    node research/v1040-core/tests/real_data_test.js
    node research/v1040-core/tests/real006_factor_test.js
