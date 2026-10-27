# V13 Limit-Up Precursor Discovery (Research Only)

## Objective

Rank A-share candidates that may enter a strong 1–5 trading-day move before a limit-up event. The target is earlier discovery, not simply selecting stocks that have already risen the most. This is an experimental ranking model, not a calibrated probability model and not a promise to predict limit-ups.

The V13 scoring layer remains research-only. On this research branch, the page has an optional one-click observation panel backed by `/api/v13_prelimitup`; it does not alter the primary V10 signal, sizing, stops, or order execution. The panel is not deployed to the default branch.


## Policy + market-regime overlay (V13 research)

The live observation ranking now uses a curated, source-linked policy taxonomy and a market-regime-aware score overlay. It is intentionally an **evidence-weighted sector alignment score**, not a claim that a specific listed company receives a subsidy, has a government-backed order, or will rise.

### Official policy catalog currently represented

- **2026-10-21 — 关于推动科技创新和产业创新深度融合的意见**, Ministry of Science and Technology official publication: https://www.most.gov.cn/xxgk/xinxifenlei/fdzdgknr/fgzc/gfxwj/gfxwj2026/202610/t20261021_197540.html
- **2026-10-09 — 关于发展新质生产力的意见**, Ministry of Industry and Information Technology official publication: https://www.miit.gov.cn/xwfb/szyw/art/2026/art_bb063b402f814c2d829cb53688ee84c0.html
- **2026-10-13 — 关于加快推进科技兴商的意见**, Ministry of Commerce official publication: https://www.mofcom.gov.cn/zcfb/zc/art/2026/art_202618c40d1943e9abfed97cef83e671.html

The current map covers AI/computing, robotics/embodied AI, semiconductors and next-generation IT, industrial digitalization, new energy/materials, smart EVs, biomedicine/bio-manufacturing, aerospace/low-altitude economy, frontier technology (quantum, hydrogen/fusion, BCI, 6G), high-end equipment, and commerce digitization. The catalog is reviewed at 2026-10-26; new official documents must be verified and added before they influence scoring. It is not yet an automatic crawler of every government website, so the UI exposes the catalog version and review timestamp.

### How the score affects selection

- Policy matching requires a keyword match in the stock's industry/theme metadata or in a time-verified company-news headline. Stock name alone is not enough.
- Each match returns its matched terms, official document title/date/source/URL, evidence type, and score. News published after the requested signal cutoff is ignored.
- The live model derives market regime from available index changes plus the ranked quote sample. When only a ranked sample is available, the result explicitly says so; it must not be described as full-market breadth.
- Policy weight is **14% in risk-on, 10% in neutral, and 6% in risk-off** conditions. The market-fit overlay weight is 10% in risk-on/neutral and 14% in risk-off. Policy score is capped at 55 when flow or trend confirmation is weak, preventing a policy narrative from overwhelming market evidence. If the catalog has not been reviewed for more than 14 days, its policy weight falls to 25% of normal until reviewed again.
- The combined V13 observation list reserves up to six slots for policy-aligned candidates only when policy score >=75, flow score >=55, trend score >=45, market-fit score >=55, overall score >=55, and the pre-limit-up risk gate passes.
- The V13 observation list displays policy score, market-fit score, matching themes, and links to official source documents. The production V10 executable signal and order permissions remain unchanged until walk-forward tests demonstrate repeatable improvement.

## Why the design differs from the current one-click screen

- **Discovery coverage is separate from execution permission.** ChiNext names (300/301), STAR names (688/689), and Beijing listings can be scored in broad diagnostic lanes. The strict primary core-leader shortlist also requires main-board classification and `executionEligible !== false`; non-main-board and unknown-board names cannot fill primary slots.
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

Run the full-universe historical collector manually from GitHub Actions using **V13 historical limit-up replay**. It uses conservative request concurrency by default to reduce upstream throttling. For live observation, the one-click panel uses a bounded 320-symbol timestamped-news prescreen diversified across liquidity, capital inflow, swing momentum, daily move and turnover, then deep-scans at most 90 base candidates plus up to 20 catalyst additions. This bounded scan is a recall/latency compromise, not an exhaustive news search of every listed company.

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

The walk-forward evaluator now also runs the same **strict four-layer core-leader gate** used by the live observation panel and reports its T+1/T+3/T+5 outcomes separately as `coreSelectionEvaluation`. This is deliberately stricter than the technical-ranking comparison. It accepts policy/leader features only when the replay row carries explicit point-in-time metadata dated no later than the signal cutoff; timestamped company news is filtered by publication time. The current full-universe replay does not contain historical theme-leadership snapshots or a versioned historical policy catalog, so the strict selector should currently report `NOT_MEASURABLE` and return no core picks for those historical dates. That is an evidence gap, not a model success or a reason to infer leadership from price rank alone. A future historical metadata capture must include the catalog version, industry/theme metadata as-of date, and dated leader evidence before this evaluation can qualify. The live shared ranking pipeline also explicitly applies the `policyAwareComposite` when `modelVariant: 'v13-policy-aware'` is requested; this keeps the live ranked list consistent with the point-in-time policy/regime score rather than silently falling back to the technical core composite. The one-click UI shows the dominant failed-gate counts when the strict shortlist is empty, without promoting rejected names into the recommendation list. Main-board execution eligibility uses explicit known Shanghai/Shenzhen code prefixes and rejects inconsistent exchange metadata. The live funnel reserves additional capacity for main-board consensus, capital-inflow, and price-momentum lanes so growth-board momentum cannot crowd out executable names before strict gates are assessed. Policy catalog v3 adds the State Council's [`人工智能+` action](https://www.miit.gov.cn/xwfb/szyw/art/2025/art_f8bd63905b384841a84e643c1b9455c7.html) and the NDRC/NEA [2025–2027 new-energy-storage action plan](https://www.ndrc.gov.cn/xxgk/zcfb/tz/202509/t20250912_1400425.html). The storage theme prefers its sector-specific official document instead of automatically citing a broader innovation policy. The catalog review timestamp is explicit, so the updated taxonomy is not retroactively applied to signals whose cutoff predates the review.

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
| 莱美药业 (300006) | 4,025 | 3,090 | 4,299 | Emotion-repair watch rank 1 |
| 兆讯传媒 (301102) | 895 | 4,922 | 2,818 | Oversold watch rank 389 |
| 致尚科技 (301486) | 485 | 4,088 | 4,007 | Oversold watch rank 1,163; this was not a closed limit-up |

None of the three true limit-up targets reached the top 30 in the current composite, core-only, early-turn, momentum-hybrid, cross-sectional rank-ensemble, raw five-session-momentum, or V12 Early Opportunity global rankings. The momentum-hybrid ranks were 623 (三维天地), 285 (莱美药业), 5,047 (兆讯传媒), and 4,392 (致尚科技); the cross-sectional rank-ensemble ranks were 509, 1,441, 4,456, and 5,173. The raw five-session-momentum ranks were 1,171, 42, 4,331, and 5,389; it surfaced 莱美药业 within the top 50 but missed the other three. V12 Early Opportunity ranks were 2,570, 5,246, 2,969, and 4,076 respectively. The emotion-repair lane surfaced 莱美药业 at rank 1, but its global rank was poor; the oversold lane still produced too many weak candidates. This is a model miss, not a successful prediction.

## 60-date walk-forward evaluation

The qualified replay covered 5,897 of 5,922 current symbols (99.58% historical-bar coverage) and 98.56% T+5 outcome coverage across 60 signal dates. The current listing is used as a proxy for the historical universe, not an exchange-certified point-in-time constituent snapshot.

| Top-K ranking | T+5 mean close return | T+5 win rate | Limit-up hit precision within 5 sessions | Mean maximum adverse excursion |
|---|---:|---:|---:|---:|
| Balanced blend, top 10 | +1.79% | 50.79% | 21.27% | -6.56% |
| Five-session momentum, top 10 | +0.62% | 43.59% | 38.39% | -11.92% |
| V12 Early Opportunity, top 10 | +0.09% | 44.63% | 1.62% | -2.41% |
| Emotion-repair watch, top 10 | -1.15% | 42.17% | 35.00% | -10.04% |
| Current composite, top 10 | -0.46% | 42.69% | 5.67% | -4.95% |
| Balanced blend, top 30 | -0.22% | 43.47% | 17.42% | -7.13% |
| Five-session momentum, top 30 | -1.40% | 39.31% | 27.64% | -11.23% |
| V12 Early Opportunity, top 30 | +0.12% | 46.35% | 1.47% | -2.49% |
| Emotion-repair watch, top 30 | -1.85% | 41.03% | 30.64% | -9.92% |

The 50/50 balanced blend is the strongest current risk/return compromise in this 60-date sample. Raw momentum finds more limit-up events, but has substantially larger adverse excursions. V12 Early Opportunity is more defensive but is not a strong limit-up detector. Emotion-repair detects many later limit-up events, but its negative T+5 returns and high adverse excursion make it a high-risk observation lane rather than a buy list.

## Supervised limit-up classifier

The point-in-time logistic classifier used 60 eligible signal dates, with 40 training dates, a five-date purge block, and 15 test dates. It used 212,937 training samples and 11,964 positive limit-up labels (5.62%).

| Ranking | Test top 10 T+5 return | Win rate | Limit-up hit precision | Test top 30 T+5 return | Top-30 limit-up precision |
|---|---:|---:|---:|---:|---:|
| Supervised limit-up classifier | -2.91% | 37.74% | 40.98% | -3.62% | 36.32% |
| Raw five-session momentum | +1.50% | 42.59% | 31.85% | -1.93% | 23.67% |

The classifier identifies more limit-up events in the test window, but the negative forward returns mean it is not a profitable standalone ranking. After excluding restricted PT/ST/delisting names, it ranked 莱美药业 #21 on the 2026-10-20 held-out signal close, but ranked 三维天地 #3,620 and 兆讯传媒 #5,185. It captured only one of the three true limit-up targets in the top 30.

## Held-out screenshot audit

Target labels were read only after rankings were computed. They are not used as training labels or model features.

| Target | Current composite | Core-only | Early-turn | Momentum-hybrid | Rank-ensemble | Raw momentum | V12 Early Opportunity | Balanced blend | Supervised limit-up |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 三维天地 (301159) | 3,919 | 460 | 154 | 623 | 509 | 1,171 | 2,570 | 1,936 | 3,620 |
| 莱美药业 (300006) | 4,025 | 3,090 | 4,299 | 285 | 1,441 | 42 | 5,246 | 83 | 21 |
| 兆讯传媒 (301102) | 895 | 4,922 | 2,818 | 5,047 | 4,456 | 4,331 | 2,969 | 3,663 | 5,185 |
| 致尚科技 (301486) | 485 | 4,088 | 4,007 | 4,392 | 5,173 | 5,389 | 4,076 | 4,559 | 3,859 |

致尚科技 rose 17.12% but did not close limit-up. The technical-only rankings still miss 三维天地 and 兆讯传媒. The early-turn lane surfaces 三维天地 at #154, but that is a watchlist signal rather than a top-30 pick. The main missing information is timestamped catalyst/theme/news evidence; simply increasing oversold weight would create falling-knife false positives.

## Current experiment

A separate supervised classifier for **T+5 close return of at least +3%** was evaluated alongside the limit-up classifier. On the 15-date test window, the positive-return model's top 10 had -1.33% mean T+5 close return, 35.26% win rate, and 19.11% positive-return precision; top 30 had -0.79% return, 37.29% win rate, and 21.48% positive-return precision. Raw five-session momentum performed better on this test window (+1.50% top-10 T+5 return and 37.04% positive-return precision). Therefore neither supervised model is currently a standalone buy-list engine.

The V13 live snapshot experiment captures a 120-symbol funnel formed from consensus rank, price momentum, capital inflow and cross-rank agreement, requests historical bars/flows plus psychology/theme/news evidence, and writes an immutable timestamped artifact. The main 30-name shortlist interleaves raw five-session momentum and V12 Early Opportunity, and can reserve at most six slots for a separate catalyst-confirmed lane. When theme psychology is missing, the live scorer now derives a fallback sector proxy from the ranked-universe rows' current industry labels and daily moves: industry breadth, limit-up participation, within-industry leadership percentile and theme heat. This is explicitly a partial cross-sectional proxy, not full exchange sector breadth, and its coverage is recorded. A catalyst-confirmed candidate must have a timestamp-verified positive event headline, a valid technical base, and pass the pre-limit-up eligibility gate; its score combines the headline event class with trend, volume-price, flow, sector, price reaction and short momentum. Emotion-repair, oversold and negative-news scores remain distinct observation/risk lanes. The pre-limit-up gate excludes names already at least 75% of their board limit, up more than 25% over five sessions, more than 18% above the prior 20-day high, or classified as `extended`; excluded names remain in `diagnosticRankings`. PT, ST and delisting-status names are excluded from candidate scoring. Intraday daily bars are partial observations. Timezone-naive news timestamps are interpreted as China Standard Time; future or untimestamped headlines are not used as point-in-time catalyst evidence. The event taxonomy covers generic contracts/orders, earnings improvement, approvals, strategic deals, product launches/digital transformation, policy support, and negative regulatory/earnings/shareholder/operating risks. Generic news recency or count alone no longer boosts the main score. The event classifier and limited catalyst blend remain experimental, not a calibrated sentiment or profitability model, and have not been validated on a broad historical point-in-time news dataset. The latest completed market-hour capture on 2026-10-22 covered 120 funnel symbols: 95.83% had sufficient bar history, 79.17% had non-degraded Eastmoney K-line plus flow sources, 50% had successful psychology endpoint responses, 40% had mapped themes, and 99.17% had timestamped stock-news evidence. Because full K-line/flow coverage was below 90%, the snapshot was `SOURCE_UNAVAILABLE`; its actionable rankings were suppressed. Per-symbol K-line/flow retries have since been added, and tests pass, but a fresh market-hour capture is still required to see whether the source-quality gate clears. The snapshot code fails closed: if any quality gate fails, recommendation ranking arrays are empty and unfiltered rankings are preserved only under `diagnosticRankings`; the workflow uploads the diagnostic artifact and then fails. This prevents degraded-source ranks from being mistaken for a valid shortlist. The scheduled workflow is research-only and its cron triggers become active only if this workflow is present on the repository's default branch. 

### Full-universe premarket catalyst sweep (experimental)

The live research workflow now has an optional **wide-news scan**. On the weekday 09:15 Asia/Shanghai schedule it attempts to enumerate the current listed universe, query timestamped stock-news results in small batches, and retain only positive, time-verified headline candidates. It then checks live/last-available quotes, excludes candidates already at 75% of their board limit, adds at most 20 new symbols to the regular funnel, fetches their K-lines/flows/theme context, and reserves up to six slots in the 30-name combined shortlist for catalyst-confirmed candidates. The main balanced ranking and catalyst lane remain separately available for audit.

This specifically addresses the candidate-coverage gap: a stock with modest price momentum or weak previous-day capital flow can now enter through timestamped company/sector news rather than having to appear in one of the original top-ranked quote lists. The sweep uses the current listing universe and current news-search results; it is a live discovery workflow, not a historical-news backtest. It does **not** establish that the screenshot targets would have ranked highly before their 2026-10-21 moves. In particular, news published after a stock has already hit its limit cannot be used as a pre-limit-up signal.

The wide scan is slow and can be throttled by public data providers. Its batch coverage, positive-catalyst count, quote-eligible count, and number of added candidates are recorded under `coverage.wideNewsScan`. GitHub scheduled workflows only execute from the repository's default branch, so this 09:15 schedule will not run automatically while the workflow remains on this research branch; the first capture requires a manual run from an available workflow-dispatch entry or later activation after the workflow is deliberately merged. If the wide scan fails, the normal funnel remains available for independent source-quality validation; no unverified news candidate is added. The existing quality gate still suppresses recommendation rankings when core K-line/flow/theme sources are insufficient. The workflow remains research-only and does not change production.

This does not change the production app.

### V13 next-session limit-up ignition lane (experimental)

The live snapshot now emits a separate `rankings.limitUpIgnitionWatch` lane for momentum-continuation candidates. This lane is intentionally distinct from `preBreakoutWatch`: the strict pre-breakout gate rejects a same-day move at or above 6.5%, while the main-board entry gate rejects moves above 7.5%. Those gates are appropriate for avoiding late entries in a compressed-base strategy, but can omit a stock's first strong leg before a next-session continuation. The new lane evaluates board-specific daily-limit bands, 3/5-day momentum, close location, volume expansion, sector strength, flow evidence, and verified leader evidence without promoting a high score to a buy signal.

The candidate funnel also reserves a separate `next-day-ignition-band` lane and includes the supported Beijing-board code families in the diagnostic funnel. The wide news prescreen has a corresponding board-normalized ignition band. These are recall improvements within the existing bounded universe, not an exhaustive scan; a name absent from the upstream ranked universe or deep-scan budget can still be missed.

The UI exposes this lane as **次日涨停延续观察**. It is observation-only, has no calibrated limit-up probability, and requires next-session confirmation of market/sector breadth, volume/flow and price support. It must not encourage chasing a locked limit-up or a materially overextended open. The strict core selection, order permissions, position sizing and production V10 signal are unchanged.

A previous point-in-time replay also found that three of four known limit-up targets were not in the top 30 of the main global rankings at the 2026-10-20 close. This supports treating recall as a measured model weakness rather than fixing it by manually boosting known winners. Evaluate the new lane with chronological walk-forward precision/recall and T+1/T+3/T+5 returns before changing live trading behavior.

### V13 pre-breakout watch lane (experimental)

The live snapshot now emits a separate `rankings.preBreakoutWatch` lane alongside the stricter four-layer core selection. It targets compressed bases near the prior 20-session high, improving short-term trend, sustained capital-flow evidence, sector strength, and dated policy/theme-leader evidence before the price becomes extended. It rejects non-main-board or inconsistent-board names, insufficient histories, persistent downtrends, prices too far from resistance, and already-extended moves. The lane labels a candidate `PREBREAKOUT_LEADER_WATCH` only when leader and policy evidence are both verified and the flow/sector checks pass; otherwise it can only be a `PREBREAKOUT_SETUP_WATCH`, not a confirmed leader.

The score is a heuristic ranking, **not** a probability of breakout, a buy signal, or evidence of positive expected return. Missing policy/leader data lowers evidence coverage and prevents the confirmed-leader label. When available, cross-sectional industry-relative strength may contribute as a weak ranking proxy only when at least five peers are present; it is displayed separately and never upgrades a candidate to a verified theme leader. A candidate appearing on this watchlist means "monitor for a valid breakout trigger"; it does not mean to buy before confirmation. The lane is now included as a separate comparison in the point-in-time walk-forward report, with T+1/T+3/T+5 outcome metrics. Its strict leader/policy subpopulation remains `NOT_MEASURABLE` whenever historical evidence is absent; the score must not be tuned or promoted on a window where those evidence gates fail.

## Validation gate before integration

1. Keep the screenshot names as a held-out audit set; do not tune directly on their outcomes.
2. Expand point-in-time data collection, especially historical capital-flow and timestamped theme/news features.
3. Compare limit-up precision, T+1/T+3/T+5 returns, positive-return precision, drawdown, liquidity, and transaction-cost assumptions across multiple market regimes.
4. Keep this model research-only until out-of-sample improvement is repeatable and risk-adjusted.

A high score means worth investigating, not buy now. Execution eligibility and account permission remain separate gates.


## Entry readiness versus discovery (v9)

A high discovery score is **not** sufficient to label a stock as an entry candidate. Each scored row now exposes `entryEligible` and `entryGateReasons`, separately from `discoveryEligible` and the board/account-only `executionEligible` field.

The actionable pre-limit-up rankings require all of the following initial guardrails:

- Daily move remains below the entry cap: 7.5% for Shanghai/Shenzhen main board, 15% for ChiNext/STAR, and 22.5% for Beijing Stock Exchange.
- At least two sector/industry evidence fields are present.
- At least five historical flow observations exist, at least 60% of observed flow periods are positive, and five-period main flow is positive.
- Score is at least 60 and data confidence is at least 65.

Rows that fail remain available in the candidate audit trail and `diagnosticRankings.entryGateRejected`, with explicit reasons, but are not promoted into the actionable pre-limit-up, catalyst-confirmed, or policy-confirmed rankings. If no candidate passes, the system should show no entry-ready candidates rather than force a pick.

These are conservative research guardrails motivated by the October 26, 2026 audit: 大西洋 (600558) appeared in the deep-scan candidate pool only after its daily move had reached +10.1%, while 华数传媒 (000156) ranked highly despite weak sector evidence and only 40% positive historical flow periods. The gates are not a calibrated probability or a buy recommendation; their thresholds must still be evaluated in walk-forward tests.


## Next-session action plan and prior-pick follow-through (v10)

The live snapshot now emits `nextDayActionPlan`, separating a candidate's discovery rank from its next-session decision state. The scheduled workflow restores the most recent **validated** snapshot from an earlier China-local trading date and passes it to the current capture. Multiple snapshots from the same trading date are not counted as next-day follow-through.

The current action states are deliberately conservative:

- `MOVE_MATERIALIZED_NO_CHASE`: today's move has reached or nearly reached the board limit; log that the prior signal followed through, but do not convert it into a chase entry.
- `EXTENDED_WAIT_PULLBACK`: the current daily move exceeds the entry cap; wait for a new setup rather than chasing.
- `WEAKENED_REASSESS_RISK`: the stock is down more than 2% on the day; re-check the thesis, theme/flow evidence, and planned risk. The model never recommends automatic averaging down.
- `ENTRY_TRIGGER_WATCH`: the row passes the model's entry-readiness gates and score threshold, but still requires a separately verified real-time trigger, liquidity check, and pre-defined stop. This is not an order.
- `WATCH_ONLY`: the score or evidence gates do not justify an entry state.
- `NOT_REASSESSED`: a prior pick is absent from today's candidate coverage. This is explicitly not counted as a failed signal.

The prior-day audit includes the previous rank/score, current rank/score when available, today's return, follow-through classification, and reason. If no earlier validated snapshot is available, the output marks `CURRENT_ONLY_NO_PRIOR_SNAPSHOT` and does not fabricate a follow-through result. To run the comparison manually, pass `--previous-snapshot path/to/previous-snapshot.json` to `live_snapshot.js`.

This directly addresses two different failure modes observed in the October 26, 2026 review: **a candidate that only appears after its move is extended** (大西洋, 600558, around +10.1%) and **a high-ranked candidate whose sector/flow confirmation is weak** (华数传媒, 000156, with only 40% positive historical flow periods in that audit). The first should be tracked as a signal that materialized, not chased after the fact; the second should remain watch-only unless it independently passes entry gates. A one-day loss alone is not enough to conclude that a setup failed—the audit must compare the signal timestamp, entry price, subsequent path, and predefined risk rules.

The action plan is research instrumentation. It does not place orders, infer a user's actual fill price, or establish profitability.
