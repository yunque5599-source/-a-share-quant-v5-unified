# V10.3.8 research integration validation — 2026-10-09

## Scope and provenance

Base inspected: new repository yunque5599-source/-a-share-quant-v5-unified, main d15241c00438ae0a45c2bb1005e84875d44b5c90. Integration branch: research/v1038-evidence-replay. The existing tree had no research/, tests/, or examples/; existing workflows were source-probe.yml and quote-batch-probe.yml. Existing production files are outside this change.

Input: AShare_V1038_Evidence_Replay_Upgrade_20261008(1).zip. Original FILE_SHA256.json inventory matched all 13 listed files before modifications. Historical statements in the supplied research intake remain package context, not newly verified Actions runs.

## Changes

- Add supplied evidence collector, account replay, offline tests, research documentation and clearly synthetic examples.
- Reject a BUY when adverse slippage moves its execution price outside the frozen price band. Do not clamp the execution price to imply an unsupported fill. Keep the existing opening-price gate, fees and entry exposure limits.
- Reject nonfinite initial capital; missing input files produce NOT_MEASURABLE instead of an unstructured exception.
- Add a read-only-permission PR workflow for offline tests; retain the supplied manual evidence collector workflow and failure-artifact retention.
- Update synthetic example output using the integrated code; it remains fictional mechanics validation only.

## Offline results

Command: `python3 -m unittest discover -s tests -v`.

36/36 passed locally (24 original tests + 12 added tests). No network is used by unit tests. Coverage includes 420 returned candidates with a larger reported pool; rejecting 421, unexplained truncation, duplicate symbols, partial lists and explicitly stale server data; transport and malformed JSON preservation with exact SHA-256; missing or duplicate BUY/WAIT; duplicate/inconsistent bars; explicit tradability; next-session execution and T+1; blocked exits; entry position limits; fees; absent marks; missing files; finite capital; and limit/slippage boundaries.

Boundary reproduction: open 10.50, frozen buyHigh 10.50, 5 bps slippage previously simulated a fill at 10.50525. It now rejects with slippage_outside_frozen_buy_band and leaves cash/holdings unchanged. Zero slippage at the upper boundary remains allowed. A slipped price equal to the upper limit remains allowed. An open below buyLow is not rescued by slippage.

These tests validate mechanics, not historic market performance. Local results do not certify GitHub Actions execution or real provider availability; check the PR and Actions UI for those separate statuses.

## Data quality and return eligibility

| Evidence | Finding | Consequence |
|---|---|---|
| Candidate pool | API returns at most 420, reported count can be larger | Truncation is accepted only under that explicit contract |
| Quote freshness | generatedAt is API generation time, not per-symbol trade/quote time | Never qualifies as a BUY/WAIT signal |
| Old generatedAt | Recency check false; structural raw archive can still be complete | rawRankArchiveComplete is not freshness or trading eligibility |
| Signal history | No complete independently frozen original BUY/WAIT archive supplied | Original V10 return is NOT_MEASURABLE; originalV10NetReturnPct is null |
| Signal SHA-256 | Loader validates format; timestamp attestation and origin bytes are not verified | User-supplied logs remain unattested; hashes alone prove no historical signal |
| Bars/calendar | Synthetic fixtures only; input dates determine sessions | Real exchange holidays, suspensions, corporate actions and survivorship remain unvalidated |
| Execution | Daily-open hypothetical fills, illustrative fees and adverse slippage | No auction queue, intraday stops, real fills or original V10 exit simulation |
| Exposure | 35% single-name/70% total checked on entry | No promise of a continuously enforced exposure ceiling |

No synthetic return is evidence of real gains. Candidate rank, historical winners and hindsight screenshots cannot be converted to original BUY/WAIT. There is no broker connection or automatic order path.

## Evidence workflow acceptance still required

The manual workflow is added on the research branch, not main. A successful live Actions run must be independently checked for raw response bytes, manifest, matching SHA-256, commit/run IDs and downloadable artifact. Do not mark that gate passed from mocked tests. Default-branch workflow registration may prevent workflow_dispatch before review/merge; do not change main merely to bypass this gate.

## Next research priorities

1. Qlib-style point-in-time datasets, experiment recording and rolling out-of-sample splits: freeze signal/config/data identifiers before the next session; preregister baselines and evaluate unseen windows. First establish a measurable baseline, rather than tune to known limit-up winners.
2. AKShare-style separate data adapters: independently reconcile historical rosters, exchange calendar, adjustments, suspensions, price limits and quote timestamps. Reject unresolved disagreements; never substitute candidate ranks for decisions.
3. RQAlpha-style event/account separation: add cash reservations, corporate actions and conservative auction/limit-state fills, with broker fee reconciliation. Evaluate turnover/cost stress and sector concentration in isolated research. Any later risk reduction rules require out-of-sample evidence before production consideration.
4. QuantStats-style continuous equity reporting: include WAIT days and rejected trades, net costs, maximum drawdown, drawdown duration, turnover and exposure; compare paired baselines on identical data and execution assumptions. No estimated improvement in net return or drawdown is claimed yet.

Architecture references: https://github.com/microsoft/qlib ; https://github.com/akfamily/akshare ; https://github.com/ricequant/rqalpha ; https://github.com/ranaroussi/quantstats . Review upstream licensing before importing code. No new upstream dependency is introduced.
