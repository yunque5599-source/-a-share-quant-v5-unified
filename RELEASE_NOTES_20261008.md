# V10.3.8 isolated research package — October 8, 2026

## Status: CODE PREPARED LOCALLY; GITHUB NOT UPDATED

Target: `yunque5599-source/-a-share-quant-v5-unified`

Read inspection of default branch: `.github/workflows/quote-batch-probe.yml`, `.github/workflows/source-probe.yml`, `index.html` (V10.2.4-S), `index_V10.3.7_UNIVERSE_DISCOVERY_SHADOW.html`, `api/market.js`, `api/discovery_universe.js` exist; `research/forward_capture.py`, `research/account_replay.py`, `tests/` and `.github/workflows/forward-evidence.yml` do not exist.

On attempted creation of `research/v1038-forward-evidence-20261008` branch, GitHub connector returned HTTP 403 Resource not accessible by integration. The reported repository metadata has admin=true but actual write operations remain denied: metadata permissions must not be treated as operational confirmation. No commits, PR, workflow runs, production changes or deployment occurred this turn.

## Changes prepared

- `research/forward_capture.py` — verifiable original ranking response archive and source meta with correct 420-cap handling; always retain manifest on provider errors; labels source/archive vs actual model signal.
- `tests/test_forward_capture.py` — 12 independent source evidence tests including cap compatibility, unexplained truncation, transport error and no silent quote freshness.
- `research/account_replay.py` — deterministic *conditional* frozen BUY/WAIT + price-bar replay; requires one decision per trading session, rejects missing snapshots and untradeable fills, next-session-open only, lot/cash/position/T+1/cost assumptions; no original account return without evidence.
- `tests/test_account_replay.py` — 12 engine tests.
- `.github/workflows/forward-evidence.yml` — manual test and raw capture workflow, upload artifacts even if failing.
- `examples/SYNTHETIC_*` — clearly non-real input fixtures. Cannot be used to claim performance.

## Recommended next action

Fix GitHub App installation repository access or use ChatGPT Work's connected GitHub authentication; then create a **new research branch**, add only these new files, run tests, open PR. Do not push to `main` directly.

## Important distinction

Current code **does not compute original V10 historical return**. Historical signal completeness, account order/fill data, corporate actions and independent quote freshness remain unresolved. Synthetic test ROI is not model ROI.