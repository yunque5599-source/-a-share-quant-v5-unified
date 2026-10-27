# 2026-10-27 Missed-signal case audit

This report is intentionally point-in-time safe. The repository does not contain a validated 2026-10-26 snapshot, full-universe input, deep history/flow payload, or dated theme evidence for the three reported symbols. The 2026-10-27 close is recorded only as a retrospective outcome and is never used to reconstruct a 2026-10-26 feature.

| Symbol | Name | 2026-10-27 retrospective observation | 2026-10-26 stage status | Result |
|---|---|---|---|---|
| 000156 | 华数传媒 | Reported +10%/material pullback context | universe, funnel, deep scan, psychology, score and entry gate unavailable | NOT_MEASURABLE |
| 002724 | 海洋王 | Reported close at 13.09, +10% | universe, funnel, deep scan, psychology, score and entry gate unavailable | NOT_MEASURABLE |
| 000678 | 襄阳轴承 | Reported close at 16.01, +10% | universe, funnel, deep scan, psychology, score and entry gate unavailable | NOT_MEASURABLE |

The missing artifact is a data limitation, not evidence that a stage passed or failed. It is therefore invalid to claim that any of the three was filtered by a specific quota, ranking cutoff, missing source, or entry gate.

The repair adds the evidence needed for a future replay:

1. funnelAudit records every input row, whether it was selected, lane membership, and explicit invalid/restricted/quota reasons.
2. The healthy ranked path requests the existing bounded full-universe discovery when the ranked pool is not full-universe sized.
3. Precursor and next-session scores expose missing flow/sector evidence instead of treating it as a neutral finite score.
4. entryEligible and entryGateReasons remain separate from discovery and next-session observation ranks.

A valid case replay requires a captured 2026-10-26 artifact with asOf <= 2026-10-26 and all point-in-time quote, bar, flow, sector/theme evidence. Until that exists, no recall, precision, return, or stage-survival metric is reported for these cases.
