# V16 market-state and overnight-impact research layer

This is an isolated research layer. It does not modify production `index.html`, `api/market.js`, production weights, deployment, broker integration, or order execution.

## Modules
- `market_transition.js`: weighted market breadth/index/turnover/sentiment/sector/leader score; BEAR, TRANSITION, BULL and DISTRIBUTION classification. BULL/BEAR require multi-session confirmation.
- `overnight_global_impact.js`: separate US semiconductor, AI-infrastructure, mega-cap, memory and cloud factors; explicit A-share industry exposure map; opening confirmation is NOT_MEASURABLE without first-15-minute/VWAP inputs.
- `sector_rotation.js`: sector persistence, rotation acceleration, prior-day profit-taking risk, and independent entry-timing score.
- `decision_overlay.js`: combines market, sector, overnight and entry gates. It never places orders.
- `replay.js`: chronological point-in-time replay and Nov 4–5 validation status; future snapshots are excluded.

## Score conventions
- Scores are 0–100; 50 is neutral. Daily returns use percentage points (e.g. -1.5 means -1.5%).
- Breadth ratios accept decimals or percentages. Full-market breadth must be explicitly labelled `universe: 'full-market'`; candidate-pool breadth is downgraded and warned.
- Initial market weights: breadth 25%, index trend 20%, turnover 15%, sentiment 15%, sector persistence 15%, leader health 10%. Missing components are excluded and confidence falls; missing values are never filled with neutral scores.
- `market_transition_score` is a change diagnostic, not a probability. `market_reversal_risk` is a risk diagnostic, not a forecast.
- US/industry impact scores use 0–100 with 50 neutral. Industry sensitivities are separate assumptions, not one universal technology coefficient.
- `policy_event_risk` only uses verified events with a source URL, severity and direction. Without them it is NOT_MEASURABLE.
- `opportunity_score` and `entry_timing_score` are independent. High opportunity does not authorize a buy.

## Data capability gates
| Metric | Required evidence | Missing-data treatment |
|---|---|---|
| Full-market breadth | Complete point-in-time A-share universe | Candidate-pool proxy clearly labelled; not full-market |
| Exact limit-up/down | Board/ST/new-listing-aware labels | Unknown labels excluded |
| Broken-board rate | Intraday limit-touch/reopen or order-book history | NOT_MEASURABLE |
| Next-day premium | Frozen signal-date list and matured next-session outcomes | NOT_MEASURABLE until matured |
| Auction/first 15m/VWAP | Timestamped minute bars and sector/leader observations | NOT_MEASURABLE; daily close is not a substitute |
| Policy/event risk | Verified event with source URL, timestamp, direction and severity | NOT_MEASURABLE |

## Replay and promotion
- Replay only frozen snapshots captured on or before the requested cutoff.
- Never use same-day close to reconstruct auction, first-15-minute, VWAP or order-book decisions.
- Evaluate Top-K precision/recall with label coverage, T+1/T+3/T+5 returns, MFE/MAE, fees, slippage, T+1, limit locks and fill constraints against untouched momentum/breakout baselines.
- This branch is research-only. No production merge/deployment until point-in-time validation passes and the user explicitly approves promotion.

## Tests
Run `node --check` on the five modules, then `node --test tests/v16_market_system.test.js`.