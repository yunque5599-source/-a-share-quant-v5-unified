# V10.3.8 research update R2 — 2026-10-09

**Local research-only package. Not yet committed to GitHub, tested in Actions, or deployed.** Original `index.html`, `api/market.js`, `api/discovery_universe.js`, repository `main`, old GitHub repository and existing Vercel deployment are untouched.

## Changes from the 2026-10-09 boundary-fix package

1. **Missing BUY execution price must fail closed.** A frozen BUY followed by a missing next-session stock bar now raises `missing execution-day bar` and the CLI exits with `NOT_MEASURABLE`. Previously such a gap was silently interpreted as a `BUY_REJECTED` with a cash-only outcome, potentially overstating returns.
2. **Account conservation audit.** A research replay now reports realized net P&L (including both entry and exit fees), unrealized net P&L for open positions (entry fees included; future exit fees excluded), ending cash and remaining positions. A run fails if the raw equity identity does not reconcile.
3. **Obvious calendar error gate.** Reject supplied Saturday/Sunday bars instead of counting them as exchange sessions. Independent China exchange holiday and corporate-action validation are still **not** implemented.
4. **Second-stage evidence verifier.** `research/verify_capture.py` checks raw response bytes, manifest SHA-256, byte count, time ordering, HTTP metadata, derived provider stats and explicit no-BUY/WAIT flags. The independent GitHub Actions verifier runs even when capture fails; artifact upload remains `if: always()`.
5. **Distinct evidence outcomes:** `integrityVerified` means local raw/manifest consistency, whereas `rankArchiveResearchUsable` requires structurally complete upstream ranking; **neither** proves per-symbol quote freshness, real original trading signals or broker fills. A trustworthy third-party historical timestamp is absent.

## Offline testing

```sh
python3 -m unittest discover -s tests -v
python3 research/account_replay.py --output examples/NOT_MEASURABLE_output.json
# The preceding command exits 2 by design: missing independently frozen BUY/WAIT.
python3 research/account_replay.py --signals examples/SYNTHETIC_signals.jsonl \
  --bars examples/SYNTHETIC_bars.csv --output examples/SYNTHETIC_output.json --synthetic-test
```

Verify the separate sample using synthetic fixtures only; do not equate the outputs with original V10 historical returns. Trading conditions such as limit-up queue, slippage fill priority, ST and listing-day price limits, intraday stopping, dividend/split adjustments and execution-source authenticity remain uncertain. Do not connect this replay to a broker or use it to automatically trade.

## GitHub handoff

The last attempt to create a new research branch through the GitHub integration returned `403 Resource not accessible by integration`. No branch/PR was created. Do not repeatedly burn Work/browser quota on the same permission problem. Once there is a verified write route: create an independent research branch, add **new** `research/`, `tests/`, `.github/workflows/forward-evidence.yml`, run tests and one manual Actions capture, inspect raw bytes, manifest, SHA-256 and verification output. Open PR, but **do not merge** without review. The user's original production code must remain unchanged.