# V14 validation status (2026-10-28)

## Current measurement status

The new V14 evaluator is implemented and tested, but the current repository does not have a quality-qualified fresh historical replay for a post-fix result.

- Fresh replay run: 40463960811
- Status: NOT_MEASURABLE
- Failure: SZ_MAIN coverage 1300/1642
- Intraday historical data: unavailable
- 2026-10-26 point-in-time artifacts for 000156, 002724 and 000678: unavailable

## Existing qualified baseline

The older qualified walk-forward artifact (run 40457161370) is a daily-bar/daily-flow baseline, not a V14 result and not cost-complete.

| Strategy | T+1 mean close return | T+3 mean close return | T+5 mean close return |
|---|---:|---:|---:|
| Balanced blend | +1.02% | +1.45% | +1.77% |
| Momentum baseline | +1.04% | +0.89% | +0.62% |

The older artifact reported 60 signal dates but used a fallback qualified replay dataset. It did not include minute data, order-book execution, limit-lock fills, or the new V14 labels. Therefore no post-fix improvement, probability calibration, or trading profitability claim is made.

## V14 target metrics

Once a quality-qualified point-in-time replay is available, v14_walk_forward.js reports Recall@10/30/50, Precision@10/30/50, T+1/T+2/T+3 first-touch labels, average lead horizon, MFE/MAE, and a transparent cost proxy against momentum and breakout baselines. Intraday cutoffs remain DATA_CAPABILITY_INSUFFICIENT until minute snapshots are collected.
