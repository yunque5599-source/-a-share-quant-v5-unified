# V10.3.8 Research Isolation · 2026-10-08

**Not a production strategy release.** All contents here are *new files* on top of the current `main` branch. DO NOT overwrite `index.html`, `api/market.js`, `api/discovery_universe.js`, or change live execution signals / Vercel settings.

## Scope and version boundary

The `main` branch currently shows production `index.html` V10.2.4-S, a separate `index_V10.3.7_UNIVERSE_DISCOVERY_SHADOW.html`, production APIs, and two diagnostic GitHub Actions workflows. This package adds a research-only evidence collector and deterministic *conditional* account replay. No automatic orders; no claims that original V10 historical returns are known.

## 1. Raw ranking capture

- `research/forward_capture.py`: downloads only the current production `ranked_candidates` response, saves `rank_raw_response.bin` verbatim and `manifest.json` (SHA-256, actual capture time, `GITHUB_SHA`, response headers, structural audit, explicit limitations). **It does not replay browser-side BUY/WAIT.**
- `research/forward_capture.py` now correctly interprets `api/market.js`'s `candidateCount` (full merged candidate count) versus `candidates` (maximum 420 returned). For reported >420, exactly 420 returned is consistent; unexplained missing rows under 420 fails closed.
- HTTP 200, completed rank lists, `serverStale=false`, or a fresh `generatedAt` *never* prove that per-stock quotes are fresh. Schedule and calendar completeness are not independently proven. No `qualifiedForTradingSignal=true` outputs exist.
- `.github/workflows/forward-evidence.yml`: runs offline tests, manually fetches once, and uploads artifacts even on failure. 30-day Actions artifact retention is not an immutable evidence store. Download and independently archive the artifacts.

Run tests (no network):

```sh
python3 -m unittest discover -s tests -v
```

Run one manual research capture (network required):

```sh
python3 research/forward_capture.py forward-evidence
```

## 2. Account replay (strict conditional research ONLY)

- `research/account_replay.py` needs **one actually frozen original-model BUY or WAIT for each evaluated signal day** and explicit date-aligned daily-bar data. Ranked candidates, screenshots after the fact, and hindsight selected winning stocks do not meet this requirement.
- Synthetic fixtures under `examples/SYNTHETIC_*` are solely for testing mechanics. They are NOT actual data or evidence of historical returns (including any dates displayed within the fixture). Run:

```sh
python3 research/account_replay.py \
  --signals examples/SYNTHETIC_signals.jsonl \
  --bars examples/SYNTHETIC_bars.csv \
  --output example-synthetic-only.json --synthetic-test
```

- Without original signals and matching bars, CLI writes `{"status":"NOT_MEASURABLE","originalV10NetReturnPct":null}` and exits nonzero rather than inventing a return:

```sh
python3 research/account_replay.py --output unmeasurable.json
```

### Input contract

`signals.jsonl`: JSON object per session (last session optional). Must contain `schema="ashare-frozen-original-signal-v1"`, `evidenceLevel="ORIGINAL_MODEL_CAPTURE"`, `decisionAt` (timezone-aware date/time), `action="BUY"` or `"WAIT"`, `evidenceSha256` (SHA256 of independently archived originating evidence). `BUY` additionally requires `code` (00.../60... A-share main board), `shares` (100-share lots), `buyLow`, `buyHigh`. Additional original-model attributes may be kept. Each day requires one frozen decision or WAIT; no invented WAIT for gaps.

`bars.csv`: `date,code,open,high,low,close,buyable,sellable`. All columns required; explicit `buyable=1/0` and `sellable=1/0`. Obtain historical bar prices and untradability flags independently, at the **same adjustment convention** and historical as-of security roster. Use a true historical exchange trading calendar: the sample implementation derives sessions from provided bar dates and is NOT a replacement for an official calendar. Restrict input to main-board codes; account for delisting, corporate actions, suspended sessions, limit up/down, and corporate-action-adjusted prices before relying on economic results.

**Method deliberately differs from full V10 strategy:** signal after observation on D is submitted for D+1 open. Buy only if both that OPEN and the adverse-slippage-adjusted execution price fall inside the frozen `buyLow`–`buyHigh`; model-specified shares in 100-share lots; 35% one-name and 70% total new-entry exposure caps; no same-day sale; exits at open after 3 *input* sessions (adjustable), with sellability gate. 5bps adverse slippage/side, commission 3bps with ¥5 minimum/side, 0.1bp bilateral transfer, 5bps stamp duty on sells. These are illustrative assumptions, must be reconciled with actual broker costs. No intraday stops, target-taking, queued limit-up fills or broker execution are implied. Any computed result is `HYPOTHETICAL_REPLAY_NOT_BROKER_VERIFIED`, NOT V10 realized profits.

Signal evidence SHA-256 is necessary for integrity but not independent trusted timestamping. For genuine proof, preserve the origin capture, its timestamp and an externally verifiable ledger. Data and orders recorded later cannot be promoted to frozen historical evidence.

## 3. Engineering principles borrowed from open source

- [Qlib](https://github.com/microsoft/qlib): time-isolated data snapshots, anti-leakage splits and proper factor evaluation.
- [AKShare](https://github.com/akfamily/akshare): future *independent* data-source cross checks; not implicit authorization to bypass source usage terms.
- [RQAlpha](https://github.com/ricequant/rqalpha): event-driven portfolio/bookkeeping design; review licensing and source before copying implementation.
- [QuantStats](https://github.com/ranaroussi/quantstats): analyze an authentic equity series, not best-stock top picks.
- [RD-Agent](https://github.com/microsoft/RD-Agent): future hypothesis generation only after reliable out-of-sample evaluation is in place.

## Merge and deployment criteria

1. Add files ONLY on a new branch. Review PR diff, verify no production files modified.
2. `python3 -m unittest discover -s tests -v` clean.
3. Manually run `Forward Rank Evidence (Manual)` and inspect both raw bytes and SHA-256 manifest; deliberate source failure must still upload the manifest and raw (if any).
4. Confirm no BUY/WAIT claims are inferred from ranking. Produce an actual signed/frozen signal and real execution plan before evaluating trading strategy performance.
5. Keep old GitHub repository and current Vercel production unchanged. DO NOT claim returns, or promote shadow weights, on synthetic or four-stock hindsight proxies.

*This research package does not connect to a brokerage or place orders.*
