# Held-out screenshot diagnosis — signal close 2026-10-20

## Scope and anti-leakage rule

This is a post-ranking diagnosis of the four screenshot symbols. The four names and their 2026-10-21 outcomes are not model training labels. No symbol-specific coefficients or hard-coded exceptions are added. Historical scores use bars/flows available through the 2026-10-20 close. News published after that cutoff is excluded.

## Results

Source-quality checks passed for the replay: 5,897 symbols, 99.58% bar coverage, 98.65% T+5 outcome coverage, and 60 chronological signal dates. The current holdout replay scored all four targets.

| Symbol | True closed limit-up? | Balanced-blend rank | Early-turn rank | Supervised limit-up rank | Main finding |
|---|---|---:|---:|---:|---|
| 三维天地 (301159) | Yes, +20.00% | 1,936 | 154 | 3,620 | Early-turn features saw a setup, but the signal did not enter the top-30 shortlist. |
| 莱美药业 (300006) | Yes, +20.00% | 83 | 4,299 | 21 | The emotion-repair observation lane ranked it first; the supervised limit-up classifier ranked it #21. The core trend/flow model underweighted the violent reversal after a recent limit-up. |
| 兆讯传媒 (301102) | Yes, +19.98% | 3,663 | 2,818 | 5,196 | The price/flow/industry-only model largely missed it. A dated 2026-10-19 AI/digital-media launch headline existed before the signal cutoff but is not part of the historical technical replay features. |
| 致尚科技 (301486) | No, +17.12% | 4,559 | 4,007 | 3,859 | Large gain, but not a closed limit-up. Treat it as a positive-move comparison, not a true limit-up hit. |

References for the event context:
- 三维天地's 2026-10-21 outcome and same-day data-asset/inspection-testing discussion: https://stock.stockstar.com/RB2026102100028252.shtml and https://finance.sina.com.cn/stock/aiassist/ydfx/2026-10-21/doc-inivyaau8017267.shtml. These are post-event reports and must not be used as 2026-10-20 features.
- 兆讯传媒's dated 2026-10-19 "跃然AI" launch coverage: https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/sz301102.phtml. This is pre-cutoff evidence, subject to independently verifying the exact published timestamp and availability to the scanner.
- 莱美药业's 2026-10-20 -15.49% selloff and 2026-10-21 +20.00% reversal: https://cn.investing.com/equities/chongqing-lummy-pharmaceutical-historical-data.

## Walk-forward evidence (60 signal dates)

For the top-10 shortlist:
- Balanced blend: mean T+5 close return +1.77%, win rate 50.59%, mean maximum adverse excursion -6.59%, limit-up hit precision 21.38%.
- Raw five-session momentum: mean T+5 close return +0.62%, win rate 43.59%, mean maximum adverse excursion -11.92%, limit-up hit precision 38.39%.

Interpretation: the balanced blend had better mean T+5 return and materially smaller adverse excursion in this sample, while raw momentum found more limit-up events at the cost of much worse drawdown. These are retrospective historical metrics, not a guarantee of future performance; transaction costs and live source availability still matter.

The supervised limit-up classifier captured 莱美药业 in the top 30 but had negative test-window T+5 returns. It must not be used alone as the live buy list.

## Engineering decision

1. Keep the technical ranking and the event/catalyst ranking separate and auditable.
2. For live discovery, run the wide timestamped-news sweep so a candidate need not already rank highly on price or capital flow. The sweep may add candidates only when positive news timestamps are verified and current price/technical eligibility is checked.
3. Do not inject target-specific labels, news headlines, or hand-tuned bonuses into historical scores. A broad historical point-in-time news corpus is required before claiming that the catalyst lane improves historical recall.
4. Preserve separate observation lanes for emotion-repair and oversold reversal. 莱美药业 is a useful example of why these lanes matter, but a sharp selloff alone is not a buy signal.
5. Keep production unchanged. Before integration, compare catalyst-on versus catalyst-off over many signal dates with identical universes and strict as-of news cutoffs, measuring top-10/top-30 limit-up recall, T+1/T+3/T+5 returns, maximum adverse excursion, liquidity and costs.
