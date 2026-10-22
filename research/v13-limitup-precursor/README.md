# V13 Limit-Up Precursor Discovery (Research Only)

## Objective

Rank A-share candidates that may enter a strong 1–5 trading-day move before a limit-up event. The target is earlier discovery, not simply selecting stocks that have already risen the most. This is an experimental ranking model, not a calibrated probability model and not a promise to predict limit-ups.

This module is isolated from the production page, market API, current execution rules, and automatic trading. It must be evaluated in historical replay before any UI or execution integration.

## Why the design differs from the current one-click screen

- **Discovery coverage is separate from execution permission.** ChiNext names (300/301), STAR names (688/689), and Beijing listings can be scored for research coverage. By default, only Shanghai/Shenzhen main-board codes are marked execution-eligible; this does not suppress a research candidate from the ranked list.
- **No narrow same-day gain gate.** A candidate is not hard-rejected because it is up 4%, 8%, or close to its limit. Overheating is a soft risk penalty, not a discovery filter.
- **The model seeks a transition, not just a strong snapshot.** It scores MA turning/stacking, price position versus the prior 20-day range, volume compression followed by expansion, closing strength, flow persistence/acceleration, and sector/theme breadth.
- **A separate emotion-repair lane catches high-volatility dislocations.** It checks recent limit-up history, a sharp selloff, volume expansion, sector context, and early recovery. It is explicitly an observation/ranking lane, not an automatic buy signal; a limit-up history followed by a crash can also be a trap.
- **An oversold-stabilization lane separates falling-knife risk from early repair.** It scores drawdown from the recent high, proximity to the 20-day range low, 3/5-day selloff, intraday close location, volume exhaustion, and whether fund-flow deterioration is easing. This path is experimental and must pass walk-forward comparison before production use.
- **Each score is auditable.** Output includes six component scores, risk penalties, risk flags, confidence/data completeness, setup classification, board, and execution eligibility.
- **Point-in-time cutoff.** When asOf is supplied, bars and fund-flow rows dated after that day are discarded. Undated rows are discarded under a cutoff to reduce look-ahead risk.

## Score composition

| Component | Weight | What it measures |
|---|---:|---|
| Trend transition | 22% | Close versus MA5/10/20, MA slopes, 3/5-day direction |
| Volume-price structure | 20% | Volume expansion, prior volume compression, close location, breakout distance |
| Fund-flow persistence | 20% | Positive-flow share, flow relative to turnover, 3-day acceleration, 5-day net flow |
| Sector/theme context | 18% | Sector returns, advancing breadth, limit-up participation, leader/catalyst scores |
| Short momentum | 12% | 3/5/10-day returns, with diminishing benefit for extreme moves |
| Base/room | 8% | Distance from prior 20-day low and high |

The trend-transition path uses the six weighted components below. Separate emotion-repair and oversold-stabilization scores can outrank the core score when recent limit-up history is followed by a sharp, high-volume selloff or when a drawdown near the recent low begins to stabilize. The final score is the highest path score minus a soft risk penalty (capped at 30 points) for excessive gains, large gaps, extreme volume/volatility, weak liquidity, and extreme turnover. ST/delisting-risk names are excluded. Missing flow/sector inputs lower confidence and are flagged rather than silently treated as strong evidence.

## Input schema

Provide a JSON array of candidate objects. Each object should contain the following fields:

    {
      "code": "301159",
      "name": "三维天地",
      "asOf": "2026-09-03",
      "bars": [
        { "date": "2026-08-01", "open": 10.1, "high": 10.3, "low": 9.9, "close": 10.2, "volume": 1200000, "amount": 120000000, "turnoverRate": 6.8 }
      ],
      "flows": [
        { "date": "2026-09-03", "mainNet": 12000000, "mainPct": 2.4, "amount": 120000000 }
      ],
      "sector": {
        "return3Pct": 3.2, "return5Pct": 5.8, "upRatio": 0.72,
        "limitUpCount": 3, "leaderScore": 76, "catalystScore": 72, "themeHeat": 68
      }
    }

Dates must be YYYY-MM-DD. Returns and mainPct are expressed in percentage points (for example, 2.4 means 2.4%, not 0.024). upRatio is 0–1. Bar and flow histories must include only information available by the requested signal timestamp. If historical sector/theme or point-in-time news data is not available, leave it missing; do not backfill it from future outcomes.

## Run

    node --test tests/v13_limitup_precursor.test.js
    node research/v13-limitup-precursor/replay.js --input path/to/candidates.json --as-of 2026-09-03 --limit 30

## Screenshot target set

target_symbols.json records the four screenshot names as holdout replay targets for the 2026-10-21 session, using 2026-10-20 as the signal cutoff. Public history shows 三维天地 +20.00%, 莱美药业 +20.00%, and 兆讯传媒 +19.98%; 致尚科技 rose +17.12% but did not close at its limit. References: [三维天地](https://stock.stockstar.com/RB2026102100028252.shtml), [莱美药业](https://www.dabanke.com/gupiao-300006.html), [兆讯传媒](https://finance.sina.com.cn/stock/aiassist/ydfx/2026-10-21/doc-inivxvuy4796816.shtml), [致尚科技历史行情](https://cn.investing.com/equities/shenzhen-zesum-technology-historical-data). The point-in-time full-universe replay has now been run. It reconstructs the four names' ranks at the 2026-10-20 close, but none of the main global rankings placed the three true limit-up targets in the top 30. The results are recorded below. Do not tune weights to force these four names to rank highly and then report them as successful validation.

## Historical replay artifacts and quality gate

Run the full-universe historical collector manually from GitHub Actions using **V13 historical limit-up replay**. It uses conservative request concurrency by default to reduce upstream throttling.

The replay writes:
- `replay_report.json`: ranks, target audit, coverage, and a `validation` status.
- `replay_candidates.ndjson`: one candidate per line, streamed to avoid the Node.js maximum-string-length failure caused by serializing thousands of 180-bar histories as one JSON string.
- `replay_ranked.json`: scored ranking.
- `collector_diagnostics.json`: data-source and coverage diagnostics; `run_failure.json` records failures that occur after report generation.

A replay is `MEASURABLE` only when at least 90% of the collected current universe has sufficient pre-cutoff bars and every date-specific audit target was scored. Otherwise it is `NOT_MEASURABLE`; top-k ranks are diagnostic only and recall fields remain unknown rather than being reported as zero. Audit targets are fetched first solely to improve diagnostic data availability; target identities never enter the score formula. The replay workflow fails its quality gate when coverage is below 90%, and the walk-forward workflow falls back to the last known quality-qualified replay rather than treating a partial universe as valid evidence. A small separate quality-report artifact is also uploaded for future replay selection.

### Walk-forward evaluation

The historical replay workflow now runs the offline evaluator automatically after collection succeeds. To rerun the analysis manually on an existing artifact, use:

    node research/v13-limitup-precursor/walk_forward_eval.js \
      --input output/v13-history-replay/replay_candidates.ndjson \
      --quality-report output/v13-history-replay/replay_report.json \
      --signal-days 15

For each historical signal date, the evaluator reconstructs the model's inputs using only bars and flows dated on or before that date, rebuilds industry breadth/leader context from pre-signal bars, and compares the model's top 10/top 30 with a five-session-momentum baseline. Outcomes use strictly later bars to calculate T+1/T+3/T+5 close returns, limit-up hit precision/recall, maximum favorable excursion, and maximum adverse excursion. The screenshot target labels are not loaded into this evaluator.

The walk-forward report remains `NOT_MEASURABLE` if the source replay has less than 90% historical-bar coverage or fewer than three complete signal dates. Even a measurable report is evidence about the tested window only, not proof of a persistent trading edge.

### New comparison: cross-sectional momentum-confirmed rank ensemble

Because the first walk-forward run showed the raw 5-session momentum baseline beating the hand-built composites, the research branch now adds \`v13-rank-ensemble\`. It ranks candidates by cross-sectional percentiles instead of saturating raw returns into a 0–100 ramp:

- 50% five-session return percentile
- 15% three-session return percentile
- 10% ten-session return percentile
- 10% trend percentile
- 6% volume-price percentile
- 6% fund-flow percentile
- 3% industry percentile
- minus the existing soft risk penalty

The first 15-date walk-forward comparison found this rank ensemble did not beat the raw momentum baseline: top-10 T+5 mean close return was -2.84% versus +1.55% for raw five-session momentum, and limit-up hit precision within five sessions was 10.67% versus 32.33%. It remains research-only. A 50/50 interleaved shortlist combining raw momentum with V12 Early Opportunity was then evaluated on the same 15 dates: top-10 T+5 mean return +2.68%, win rate 50.26%, limit-up hit precision 16.63%, and mean maximum adverse excursion -5.41%; the raw momentum top-10 baseline was +1.55%, 42.23%, 32.33%, and -11.17%, respectively. For top 30, the blend averaged -0.09% T+5 versus -2.09% for the baseline, with -6.81% versus -11.39% mean maximum adverse excursion. This suggests a better return/drawdown compromise, but fewer limit-up hits than momentum alone; these are initial 15-date results and not yet the final selection policy.


## Initial historical results and decision

The first full-universe replay for the 2026-10-20 signal close covered 5,897 of 5,922 current symbols (99.58% with sufficient bars) and had 98.69% flow-history coverage. This is measurable enough for diagnosis, but the universe is the current listing as a proxy, not an exchange-certified historical constituent snapshot.

The held-out screenshot audit was run after ranking, with target labels excluded from feature construction:

| Target | Current composite rank | Core-only rank | Early-turn rank | Best separate observation lane |
|---|---:|---:|---:|---|
| 三维天地 (301159) | 3,919 | 460 | 154 | Early-turn component rank 199 |
| 莱美药业 (300006) | 4,033 | 3,115 | 4,311 | Emotion-repair watch rank 1 |
| 兆讯传媒 (301102) | 895 | 4,924 | 2,818 | Oversold watch rank 389 |
| 致尚科技 (301486) | 485 | 4,090 | 4,008 | Oversold watch rank 1,163; this was not a closed limit-up |

None of the three true limit-up targets reached the top 30 in the current composite, core-only, early-turn, momentum-hybrid, cross-sectional rank-ensemble, raw five-session-momentum, or V12 Early Opportunity global rankings. The momentum-hybrid ranks were 625 (三维天地), 286 (莱美药业), 5,049 (兆讯传媒), and 4,394 (致尚科技); the cross-sectional rank-ensemble ranks were 509, 1,443, 4,458, and 5,175. The raw five-session-momentum ranks were 1,173, 44, 4,333, and 5,392; it surfaced 莱美药业 within the top 50 but missed the other three. V12 Early Opportunity ranks were 2,570, 5,249, 2,969, and 4,076 respectively. The emotion-repair lane surfaced 莱美药业 at rank 1, but its global rank was poor; the oversold lane still produced too many weak candidates. This is a model miss, not a successful prediction.

## 60-date walk-forward evaluation

The qualified replay covered 5,897 of 5,922 current symbols (99.58% historical-bar coverage) and 98.56% T+5 outcome coverage across 60 signal dates. The current listing is used as a proxy for the historical universe, not an exchange-certified point-in-time constituent snapshot.

| Top-K ranking | T+5 mean close return | T+5 win rate | Limit-up hit precision within 5 sessions | Mean maximum adverse excursion |
|---|---:|---:|---:|---:|
| Balanced blend, top 10 | +1.79% | 50.79% | 21.27% | -6.56% |
| Five-session momentum, top 10 | +0.63% | 43.50% | 38.51% | -11.92% |
| V12 Early Opportunity, top 10 | +0.09% | 44.63% | 1.62% | -2.41% |
| Emotion-repair watch, top 10 | -1.15% | 42.17% | 35.00% | -10.04% |
| Current composite, top 10 | -0.46% | 42.69% | 5.67% | -4.95% |
| Balanced blend, top 30 | -0.22% | 43.45% | 17.46% | -7.13% |
| Five-session momentum, top 30 | -1.45% | 39.07% | 27.31% | -11.32% |
| V12 Early Opportunity, top 30 | +0.12% | 46.35% | 1.47% | -2.49% |
| Emotion-repair watch, top 30 | -1.85% | 41.03% | 30.64% | -9.92% |

The 50/50 balanced blend is the strongest current risk/return compromise in this 60-date sample. Raw momentum finds more limit-up events, but has substantially larger adverse excursions. V12 Early Opportunity is more defensive but is not a strong limit-up detector. Emotion-repair detects many later limit-up events, but its negative T+5 returns and high adverse excursion make it a high-risk observation lane rather than a buy list.

## Supervised limit-up classifier

The point-in-time logistic classifier used 60 eligible signal dates, with 40 training dates, a five-date purge block, and 15 test dates. It used 212,937 training samples and 11,964 positive limit-up labels (5.62%).

| Ranking | Test top 10 T+5 return | Win rate | Limit-up hit precision | Test top 30 T+5 return | Top-30 limit-up precision |
|---|---:|---:|---:|---:|---:|
| Supervised limit-up classifier | -3.82% | 34.52% | 37.02% | -3.44% | 36.90% |
| Raw five-session momentum | +1.55% | 42.23% | 32.33% | -2.09% | 22.41% |

The classifier identifies more limit-up events in the test window, but the negative forward returns mean it is not a profitable standalone ranking. It ranked 莱美药业 #23 on the 2026-10-20 held-out signal close, but ranked 三维天地 #3,720 and 兆讯传媒 #5,252. It captured only one of the three true limit-up targets in the top 30.

## Held-out screenshot audit

Target labels were read only after rankings were computed. They are not used as training labels or model features.

| Target | Current composite | Core-only | Early-turn | Momentum-hybrid | Rank-ensemble | Raw momentum | V12 Early Opportunity | Balanced blend | Supervised limit-up |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 三维天地 (301159) | 3,919 | 460 | 154 | 625 | 509 | 1,173 | 2,570 | 1,939 | 3,720 |
| 莱美药业 (300006) | 4,025 | 3,091 | 4,300 | 286 | 1,443 | 44 | 5,249 | 87 | 23 |
| 兆讯传媒 (301102) | 895 | 4,924 | 2,818 | 5,049 | 4,458 | 4,333 | 2,969 | 3,665 | 5,252 |
| 致尚科技 (301486) | 485 | 4,090 | 4,008 | 4,394 | 5,175 | 5,392 | 4,076 | 4,561 | 3,868 |

致尚科技 rose 17.12% but did not close limit-up. The technical-only rankings still miss 三维天地 and 兆讯传媒. The early-turn lane surfaces 三维天地 at #154, but that is a watchlist signal rather than a top-30 pick. The main missing information is timestamped catalyst/theme/news evidence; simply increasing oversold weight would create falling-knife false positives.

## Current experiment

A separate supervised classifier for **T+5 close return of at least +3%** was evaluated alongside the limit-up classifier. On the 15-date test window, the positive-return model's top 10 had -1.13% mean T+5 close return, 35.42% win rate, and 16.76% positive-return precision; top 30 had -0.77% return, 37.12% win rate, and 20.91% positive-return precision. Raw five-session momentum performed better on this test window (+1.55% top-10 T+5 return and 37.51% positive-return precision). Therefore neither supervised model is currently a standalone buy-list engine.

The V13 live snapshot experiment captures a 120-symbol funnel formed from consensus rank, price momentum, capital inflow and cross-rank agreement, requests historical bars/flows plus psychology/theme/news evidence, and writes an immutable timestamped artifact. The main 30-name shortlist interleaves raw five-session momentum and V12 Early Opportunity, and can reserve at most six slots for a separate catalyst-confirmed lane. When theme psychology is missing, the live scorer now derives a fallback sector proxy from the ranked-universe rows' current industry labels and daily moves: industry breadth, limit-up participation, within-industry leadership percentile and theme heat. This is explicitly a partial cross-sectional proxy, not full exchange sector breadth, and its coverage is recorded. A catalyst-confirmed candidate must have a timestamp-verified positive event headline, a valid technical base, and pass the pre-limit-up eligibility gate; its score combines the headline event class with trend, volume-price, flow, sector, price reaction and short momentum. Emotion-repair, oversold and negative-news scores remain distinct observation/risk lanes. The pre-limit-up gate excludes names already at least 75% of their board limit, up more than 25% over five sessions, more than 18% above the prior 20-day high, or classified as `extended`; excluded names remain in `diagnosticRankings`. PT, ST and delisting-status names are excluded from candidate scoring. Intraday daily bars are partial observations. Timezone-naive news timestamps are interpreted as China Standard Time; future or untimestamped headlines are not used as point-in-time catalyst evidence. The event taxonomy covers generic contracts/orders, earnings improvement, approvals, strategic deals, product launches/digital transformation, policy support, and negative regulatory/earnings/shareholder/operating risks. Generic news recency or count alone no longer boosts the main score. The event classifier and limited catalyst blend remain experimental, not a calibrated sentiment or profitability model, and have not been validated on a broad historical point-in-time news dataset. The latest completed market-hour capture on 2026-10-22 covered 120 funnel symbols: 95.83% had sufficient bar history, 79.17% had non-degraded Eastmoney K-line plus flow sources, 50% had successful psychology endpoint responses, 40% had mapped themes, and 99.17% had timestamped stock-news evidence. Because full K-line/flow coverage was below 90%, the snapshot was `SOURCE_UNAVAILABLE`; its actionable rankings were suppressed. Per-symbol K-line/flow retries have since been added, and tests pass, but a fresh market-hour capture is still required to see whether the source-quality gate clears. The snapshot code fails closed: if any quality gate fails, recommendation ranking arrays are empty and unfiltered rankings are preserved only under `diagnosticRankings`; the workflow uploads the diagnostic artifact and then fails. This prevents degraded-source ranks from being mistaken for a valid shortlist. The scheduled workflow is research-only and its cron triggers become active only if this workflow is present on the repository's default branch. This does not change the production app.

## Validation gate before integration

1. Keep the screenshot names as a held-out audit set; do not tune directly on their outcomes.
2. Expand point-in-time data collection, especially historical capital-flow and timestamped theme/news features.
3. Compare limit-up precision, T+1/T+3/T+5 returns, positive-return precision, drawdown, liquidity, and transaction-cost assumptions across multiple market regimes.
4. Keep this model research-only until out-of-sample improvement is repeatable and risk-adjusted.

A high score means worth investigating, not buy now. Execution eligibility and account permission remain separate gates.
