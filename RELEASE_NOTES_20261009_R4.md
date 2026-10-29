# V10.3.8 R4 — conservative fills & sensitivity diagnostics (2026-10-09)

**Local research-only release.** No write to GitHub, no PR, no production deployment; main and Vercel remain untouched.

## Changes

1. `research/account_replay.py`: refuse to infer fills from one-price session bars (`open==high==low==close`) even if a user-supplied `buyable` or `sellable` flag says 1. Buyers are rejected; due exits are deferred and retried later. This is intentionally conservative: a one-price day can have trades, but day OHLC alone cannot prove queue priority or investor fill.
2. Add research-only `--slip-bps` (0–100) and `--fee-multiplier` (1–5) parameters; baseline defaults remain 5bps and 1x. Costs include actual configured minimum commission when multiplied; sensitivity mode makes no prediction about brokerage fills.
3. Add `research/stress_replay.py` scenario grid: 0/5/10/20bps × 1x/2x fees; compare return and drawdown, and **disclose whether the execution path differs** across scenarios. If paths differ, do not claim that larger slippage is a monotonic worst-case return bound.
4. Ten focused tests for one-price sessions, deferred exits, fee deterioration, grid path drift, missing evidence and synthetic labeling. The unchanged original signal log, exchange calendar completeness, raw SHA verifier and fail-closed handling are retained.

## Evidence standard and limitations

- A synthetic test can show that software mechanics behave as specified; it is not a historical return or a forward prediction.
- Source-controlled `buyable` and `sellable` flags are not independently attested brokerage fills; daily price bars do not certify limit-up queue position.
- The replay still applies a hypothetical fixed holding period rather than the original V10 exit algorithm, and real BUY/WAIT evidence is missing. Actual V10 net returns remain **NOT_MEASURABLE**.
- No automatic trading, changes to production selection rules, or Vercel changes.

## Offline test command

`python3 -m unittest discover -s tests -v`

## Before any GitHub release

Permission must be repaired for write operations; install on an isolated research branch with PR review and do not merge to main by default. Perform a fresh manual Actions archive run, verify raw+manifest SHA, require safe failure handling and independent timestamped BUY/WAIT before true performance claims.