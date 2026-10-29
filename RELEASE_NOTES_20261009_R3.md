# V10.3.8 research update R3 — 2026-10-09

**Only a local offline research upgrade.** No GitHub changes were published, no Actions capture was run, no Vercel or original trading rules were modified. It is not an automatic trading agent or a proven profitable strategy.

## Critical correction: independent weekday-complete exchange calendar

The previous replay inferred the session calendar from the union of supplied quote-bar dates. If the raw data omitted a *whole actual trading date*, that date could disappear silently, altering both the next-open entry and the holding period. Historical P&L would then be potentially biased with no error.

R3 introduces `research.account_replay.load_calendar()` and a **required `--calendar`** argument in non-synthetic command-line runs. The input `date,is_open` CSV must list every weekday between first and final observed bar; `is_open=1` means trading and `0` means a documented weekday holiday. The validation rejects missing weekdays, duplicate dates, weekends, dates outside the observed range and disagreements between calendar trading sessions and supplied daily prices. Every result records the supplied file's SHA-256 and marks the calendar's provenance `USER_SUPPLIED_NOT_EXCHANGE_VERIFIED`.

**This is NOT official Chinese exchange holiday verification.** An incorrect `is_open=0` could still falsely exclude a real trading day. Obtain a trustworthy historically dated SH/SZ exchange calendar and compare externally before claiming any original performance.

The synthetic fixture calendar includes all five weekday dates solely for integration tests. A synthetic run may intentionally omit the calendar but is marked as inferred and is NEVER original trading evidence.

## Additional failure protection

- Missing or inaccessible calendar/signal/bar inputs now produce `NOT_MEASURABLE` and a nonzero CLI exit, rather than an unhandled file exception.
- Existing R2 checks remain: missing BUY execution bars never become favorable rejected orders; realized and unrealized P&L reconcile with cash/equity; limit-band and OHLC slippage checks; no claimed same-day sales; independent raw/manifest SHA verifier.
- This version includes no original BUY/WAIT records and no authenticated source timestamps. Realized V10 performance remains unknown.

## Run all offline tests

```sh
python3 -m unittest discover -s tests -v
python3 research/account_replay.py --signals examples/SYNTHETIC_signals.jsonl \
  --bars examples/SYNTHETIC_bars.csv \
  --calendar examples/SYNTHETIC_calendar.csv \
  --output examples/SYNTHETIC_output.json --synthetic-test
python3 research/account_replay.py --output examples/NOT_MEASURABLE_output.json
# Last command intentionally exits 2.
```

## Provenance and scope

The scenario output is purely `SYNTHETIC_TEST_NOT_REAL_PERFORMANCE`. Cash/price/position behavior is educational and cannot be extrapolated to original V10 or future A-shares. Daily-bars cannot prove order queue priority on limit-up names, broker fills, real auction prices, corporate actions or ST/IPO-specific price limits. Retain unchanged: `index.html`, `api/market.js`, `api/discovery_universe.js`, main, legacy GitHub repository, Vercel production.

Research acceptance when authorized write works: new branch, only new `research/`, `tests/`, `.github/workflows/forward-evidence.yml`, all offline tests, one manual Actions raw evidence capture, verify manifest SHA256, failures retained, PR review; no merge or production deployment by default. Last GitHub write attempt returned 403 and Work consumed its usage quota; DO NOT repeatedly retry Work for the same permission issue.