# V15 point-in-time research protocol

## Goal

Measure whether the V15 observation lanes improve the discovery of future limit-up candidates without changing the production buy gate. This is a research workflow, not a promise of profitable returns.

## Capture

1. Run the normal one-click scan during the Shanghai continuous trading session.
2. Immediately after the scan completes (within 15 minutes), click **导出全市场研究快照** in the scan card. The temporary model snapshot is kept only on this browser/device and is replaced by the next scan.
3. The browser requests the independent `/api/discovery_universe` source and downloads one JSON file. The endpoint is read-only and does not create trade signals.
4. Keep one file per trading date. Do not edit the capture timestamp, quality flags, strategy lists, or raw rows after export.

The file includes:
- the full provider main-board universe available to the independent discovery endpoint;
- model capture time and independent universe collection start/end times;
- quote-timestamp coverage, freshness checks, source method and any collection-quality failures;
- primary top-30 candidates, the legacy shadow top-5, the V15 observation top-10, and each lane's top-5 research leaders;
- the fast independent factor-ranked observation source status, quote freshness, factor coverage, source failures, and observed-pool emotion/sector-resonance diagnostics.

The full universe is provider-defined, not exchange-certified. A capture is qualified for strict replay only when both source-quality checks pass, both sources refer to the same Shanghai trading date, and their time skew is within the configured tolerance. The collection is still not an atomic exchange snapshot.

The live V15 selector also queries `/api/discovery_candidates`, a faster independent pool made from the top two pages per factor (daily momentum, amount, main-force net flow, and main-force flow ratio) for each main-board segment. It is **not** the full market. This pool is used only for the observation shortlist, and the scan falls back to the ranked pool if its minimum freshness/coverage checks fail. Sector breadth and emotion metrics are proxies calculated from the observed candidate pool, not verified full-market statistics. The `sector-leader-proxy` lane combines within-industry relative price rank with overall-pool momentum, liquidity, capital-flow ranks, and sector resonance; it does **not** establish a real concept/theme leader or quantify that theme's future narrative potential. When at least five distinct industries are represented, the top-10 shortlist initially caps any single industry at two candidates; the cap is relaxed only if that is necessary to fill the list. The one-click scan deep-scans up to 40 candidates in two 20-code requests. A failed batch is recorded and the other batch continues; the scan stops only if the remaining successful primary candidates are too few to support the production scoring path.

## Outcome data

The replay engine expects a separate JSON file with daily bars keyed by stock code. Example:

```json
{
  "dailyBarsByCode": {
    "600001": [
      {
        "date": "2026-10-30",
        "open": 10.1,
        "high": 10.8,
        "low": 9.9,
        "close": 10.6,
        "isLimitUp": false
      },
      {
        "date": "2026-11-02",
        "open": 10.6,
        "high": 11.66,
        "low": 10.5,
        "close": 11.66,
        "isLimitUp": true
      }
    ]
  },
  "intradayBarsByCode": {}
}
```

`date` must be `YYYY-MM-DD`. Prices are unadjusted exchange prices. `isLimitUp` must be a verified Boolean from the data source. Alternatively, use `limitUpVerified: true` together with `limitUpPrice` and `high`, or `limitUpVerified: true` with a verified daily percentage change in `pct`. Unknown labels are not treated as non-limit-up outcomes.

For same-day outcomes, provide intraday bars with ISO timestamps. Only bars whose timestamp is later than the snapshot's `capturedAt` are eligible. The full daily candle for the snapshot date is always excluded because its high/low can contain pre-capture information.

## Fetch forward daily bars for tracked candidates

After exporting one or more snapshots, run the collector on a machine with Node.js 20+ and internet access:

```bash
node research/fetch_v15_bars.js snapshot_2026-10-29.json snapshot_2026-10-30.json --out=daily_bars.json --max-codes=300
```

The collector fetches unadjusted daily K-lines for the union of primary, legacy-shadow, V15 observation and individual-lane leaders in those snapshots. It derives a main-board limit-up label from the raw daily high versus the normal 10% limit price only when sufficient history is present and the snapshot name is not ST/退. IPO no-limit sessions and later ST-status changes can still require date-specific review; inspect the emitted `labelCaveat` and per-bar `limitUpVerified` fields.

**Important:** this collector follows the tracked model candidates, not every stock in the full market. Its precision comparison is useful for the legacy-vs-V15 candidate sets, but its `observedPoolRecallAtK` denominator is only the subset with fetched, verified bars. The report's low `observedUniverseLabelCoverage` must be shown alongside any recall number. Whole-market recall requires verified future labels for the complete universe, not just selected candidates.

## Run the replay

With Node.js 20+:

```bash
node research/run_v15_replay.js daily_bars.json snapshot_2026-10-29.json snapshot_2026-10-30.json
```

To inspect snapshots that failed the strict quality gate (diagnostic only):

```bash
node research/run_v15_replay.js daily_bars.json snapshot_2026-10-29.json --include-unqualified
```

The output contains per-snapshot and aggregate reports for:
- `primaryTop`: the existing stage-one primary shortlist;
- `legacyUnion`: primary top-30 plus the previous shadow top-5;
- `v15Union`: primary top-30 plus the new V15 observation top-10;
- `legacyShadowOnly`, `v15ObservationOnly`, and each individual V15 observation lane.

Use **K=35** for the equal-budget comparison (primary top-30 plus five shadow candidates on each side). **K=40** measures the expanded V15 budget of primary top-30 plus ten observation candidates; the legacy union contains only 35 candidates at that K, so the selected counts are intentionally different.

Metrics include precision among candidates with verified labels, observed-universe recall, label coverage, average forward close return, maximum favorable excursion and maximum adverse excursion. `observedPoolRecallAtK` uses only limit-up outcomes observed in the supplied universe and with verified labels; it must not be reported as whole-A-share recall unless every stock in the relevant exchange universe and all outcomes are actually covered.

## Interpretation safeguards

- Scores are rankings, not calibrated probabilities.
- Missing/unknown limit-up labels are excluded from precision/recall denominators.
- No same-day daily candle leakage.
- Returns exclude fees, slippage, limit-order queue/fill constraints, and market impact.
- The independent universe source and the model ranking source are collected separately; source skew is recorded.
- Live actionable signals are blocked if ranking timestamps are missing, the ranked source is older than three minutes, factor pages are incomplete, or fresh quote coverage is insufficient. This gate can still allow observation-only candidates to be displayed.
- The 30-second edge cache and 60-second in-memory ranking cache reduce staleness but do not guarantee an atomic exchange snapshot.
- Do not tune thresholds on the same dates used to report final performance. Use chronological train/validation/test periods, and retain an untouched out-of-sample period.
- A few selected case studies are not sufficient to establish improvement. Report the number of snapshots, label coverage, sample size, precision/recall, drawdown and stability by market regime.
