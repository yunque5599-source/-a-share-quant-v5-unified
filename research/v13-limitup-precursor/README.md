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

target_symbols.json records the four screenshot names as holdout replay targets for the 2026-10-21 session, using 2026-10-20 as the signal cutoff. Public history shows 三维天地 +20.00%, 莱美药业 +20.00%, and 兆讯传媒 +19.98%; 致尚科技 rose +17.12% but did not close at its limit. References: [三维天地](https://stock.stockstar.com/RB2026102100028252.shtml), [莱美药业](https://www.dabanke.com/gupiao-300006.html), [兆讯传媒](https://finance.sina.com.cn/stock/aiassist/ydfx/2026-10-21/doc-inivxvuy4796816.shtml), [致尚科技历史行情](https://cn.investing.com/equities/shenzhen-zesum-technology-historical-data). The full pre-limit-up bars, fund flow, and same-day full-universe ranks still need to be replayed before we can say whether the new model would have selected them. Do not tune weights to force these four names to rank highly and then report them as successful validation.

## Historical replay artifacts and quality gate

Run the full-universe historical collector manually from GitHub Actions using **V13 historical limit-up replay**. It uses conservative request concurrency by default to reduce upstream throttling.

The replay writes:
- `replay_report.json`: ranks, target audit, coverage, and a `validation` status.
- `replay_candidates.ndjson`: one candidate per line, streamed to avoid the Node.js maximum-string-length failure caused by serializing thousands of 180-bar histories as one JSON string.
- `replay_ranked.json`: scored ranking.
- `collector_diagnostics.json`: data-source and coverage diagnostics; `run_failure.json` records failures that occur after report generation.

A replay is `MEASURABLE` only when at least 90% of the collected current universe has sufficient pre-cutoff bars and every date-specific audit target was scored. Otherwise it is `NOT_MEASURABLE`; top-k ranks are diagnostic only and recall fields remain unknown rather than being reported as zero. Audit targets are fetched first solely to improve diagnostic data availability; target identities never enter the score formula.

### Walk-forward evaluation

The historical replay workflow now runs the offline evaluator automatically after collection succeeds. To rerun the analysis manually on an existing artifact, use:

    node research/v13-limitup-precursor/walk_forward_eval.js \
      --input output/v13-history-replay/replay_candidates.ndjson \
      --quality-report output/v13-history-replay/replay_report.json \
      --signal-days 15

For each historical signal date, the evaluator reconstructs the model's inputs using only bars and flows dated on or before that date, rebuilds industry breadth/leader context from pre-signal bars, and compares the model's top 10/top 30 with a five-session-momentum baseline. Outcomes use strictly later bars to calculate T+1/T+3/T+5 close returns, limit-up hit precision/recall, maximum favorable excursion, and maximum adverse excursion. The screenshot target labels are not loaded into this evaluator.

The walk-forward report remains `NOT_MEASURABLE` if the source replay has less than 90% historical-bar coverage or fewer than three complete signal dates. Even a measurable report is evidence about the tested window only, not proof of a persistent trading edge.

## Initial historical results and decision

The first full-universe replay for the 2026-10-20 signal close covered 5,897 of 5,922 current symbols (99.58% with sufficient bars) and had 98.69% flow-history coverage. This is measurable enough for diagnosis, but the universe is the current listing as a proxy, not an exchange-certified historical constituent snapshot.

The held-out screenshot audit was run after ranking, with target labels excluded from feature construction:

| Target | Current composite rank | Core-only rank | Early-turn rank | Best separate observation lane |
|---|---:|---:|---:|---|
| 三维天地 (301159) | 3,919 | 460 | 154 | Early-turn component rank 199 |
| 莱美药业 (300006) | 4,033 | 3,115 | 4,311 | Emotion-repair watch rank 1 |
| 兆讯传媒 (301102) | 895 | 4,924 | 2,818 | Oversold watch rank 389 |
| 致尚科技 (301486) | 485 | 4,090 | 4,008 | Oversold watch rank 1,163; this was not a closed limit-up |

None of the three true limit-up targets reached the top 30 in the current composite, core-only, early-turn, momentum-hybrid, raw five-session-momentum, or V12 Early Opportunity global rankings. The momentum-hybrid ranks were 625 (三维天地), 286 (莱美药业), 5,049 (兆讯传媒), and 4,394 (致尚科技). The raw five-session-momentum ranks were 1,173, 44, 4,333, and 5,392; it surfaced 莱美药业 within the top 50 but missed the other three. V12 Early Opportunity ranks were 2,570, 5,249, 2,969, and 4,076 respectively. The emotion-repair lane surfaced 莱美药业 at rank 1, but its global rank was poor; the oversold lane still produced too many weak candidates. This is a model miss, not a successful prediction.

A 15-signal-date walk-forward comparison also found that the heuristic rankings underperformed the raw five-session-momentum baseline on the tested window:

| Top-K ranking | T+5 mean close return | T+5 win rate | Limit-up hit precision within 5 sessions |
|---|---:|---:|---:|
| Current composite, top 10 | -2.93% | 31.22% | 2.74% |
| Core-only, top 10 | -2.48% | 34.67% | 5.33% |
| Early-turn, top 10 | -3.30% | 32.07% | 9.33% |
| Momentum-hybrid, top 10 | -3.31% | 33.33% | 14.00% |
| V12 Early Opportunity, top 10 | +0.04% | 40.26% | 4.98% |
| Five-session momentum baseline, top 10 | +1.55% | 42.23% | 32.33% |
| Current composite, top 30 | -2.36% | 33.11% | 4.58% |
| Momentum-hybrid, top 30 | -4.48% | 29.76% | 11.68% |
| V12 Early Opportunity, top 30 | -0.20% | 38.78% | 3.03% |
| Five-session momentum baseline, top 30 | -2.09% | 37.31% | 22.41% |

The separate emotion-repair watchlist had higher limit-up hit precision (38.67% for its top 10 within five sessions), but a -2.40% mean T+5 close return and -10.42% mean maximum adverse excursion. It should remain a high-risk observation lane, not be promoted to an unconditional buy list.

**Decision: do not merge any new ranking into the production one-click selector yet.** V12 Early Opportunity had a near-flat T+5 return with lower adverse excursion (about -2.5%), so it may serve as a more defensive low-base watchlist; however, its limit-up hit precision was only 4.98% for top 10. The raw five-session-momentum baseline remains materially better at identifying near-term limit-up events in this 15-date sample, while its drawdowns are larger. None of the tested price/volume/flow variants reliably identified all four holdout targets. The next research iteration should test a supervised, point-in-time limit-up/forward-return ranker and add genuinely time-stamped catalyst/theme/news features. In particular, 兆讯传媒's and 致尚科技's weak pre-event momentum and flow show why simply raising the oversold weight would overfit and create falling-knife false positives. Keep the screenshot names as a holdout set; do not train or tune directly on their outcomes.

## Validation gate before integration

1. Reconstruct the complete eligible universe at the 2026-10-20 close and retrieve point-in-time bars, flows, and sector/theme information for all candidates.
2. Score candidates using only data available before the target session; store the target rank, top-10/top-30 recall, and reasons for any miss. The updated holdout audit ranked 三维天地 3,919, 莱美药业 4,033, 兆讯传媒 895, and 致尚科技 485 in the current composite; early-turn improved 三维天地 to 154 but still missed the top 30. The V12 Early Opportunity score is now being compared as another independent ranking rather than assuming the new V13 heuristic is better.
3. Run walk-forward evaluation across many dates, reporting top-k limit-up recall within 1/3/5 sessions, forward returns, maximum adverse excursion, turnover/cost assumptions, and board-separated results.
4. Compare against the existing model and simple baselines. Keep this model research-only unless the out-of-sample uplift is repeatable and risk-adjusted.

A high score means worth investigating, not buy now. Execution eligibility and account permission remain separate gates.
