# V10.3.8 research-only replay price-boundary hardening — 2026-10-09

**Local artifact only; not committed or deployed. No modification to production `index.html`, `api/market.js` or Vercel.**

## Scope

Addresses an execution realism gap identified by Work in the 2026-10-08 research package:

- A frozen BUY range ending at **10.00** formerly admitted a next-session OPEN at **10.00** and then asserted an adverse-slippage execution at **10.005**, outside the model's own frozen upper buy limit. This is now a `BUY_REJECTED` event (`slippage_exceeds_frozen_buy_band`). It is never price-clipped to 10.00.
- A simulated BUY at OPEN plus adverse slippage above the actual daily HIGH is rejected (`simulated_buy_exceeds_session_high`). This is a conservative fill-eligibility assumption, not order-book simulation.
- A simulated SELL at OPEN minus adverse slippage below daily LOW is deferred (`EXIT_BLOCKED`, `simulated_sell_below_session_low`) rather than recorded as a fictitious within-day fill. The script keeps the position, retries on later supplied sessions, and marks to market at each supplied close. It does **not** claim this approximates actual intraday order handling.
- Updated synthetic OHLC fixtures with a nonzero daily range and regenerated clearly synthetic output.
- Added four regression tests for upper-band slippage, exactly on-band open without slippage, out-of-OHLC BUY and out-of-OHLC SELL.

## Verification

Run from archive root: `python3 -m unittest discover -s tests -v`. Expect **28 tests passing**, including previous 420-row cap/failure-retention tests. CLI synthetic example is a mechanics test only and produces no original-V10 performance claim. CLI without independently frozen original BUY/WAIT continues to report `NOT_MEASURABLE` with `originalV10NetReturnPct: null`.

## Important limitations and release gate

- Next-session daily OPEN plus adverse slippage is a simplifying research hypothesis; OHLC does not prove limit-up queue priority, actual auction fills, price-limit status or liquidity.
- Input buyable/sellable flags are externally supplied and **not** authenticated by the engine. Their reliability must be independently verified.
- Trading calendar is derived from supplied bars; exchange corporate actions and historical as-of universe require independent verification.
- Historic original BUY/WAIT records remain incomplete; there is no defensible original-model realized P&L. Synthetic output is NOT strategy alpha.
- Original producer's GitHub connection currently returns HTTP 403 on branch creation. Do not repeatedly consume Work browser quota or write directly into `main`. Create a research-only PR only after an authorized write path is available.
- `FILE_SHA256.json` records content checksums, not independent timestamp attestation.