# V16 narrative-theme case study: 2026-11-03 to 2026-11-06

## Publicly reported observations

This note records the public reports used to define the test case. These retrospective reports are useful for event description, but they are not substitutes for frozen point-in-time stock-universe snapshots.

- **2026-11-03 — 羊／洋／阳 cluster:** a public limit-up review listed 18 stocks in the “羊字辈” group. 东方海洋 and 阳光照明 were both reported at 4 boards. The same review listed 七匹狼 at 2 boards and 九牧王 at 1 board under textile/apparel, not as a separately validated multi-stock “狼” theme. Source: [2026-11-03 limit-up review](https://www.kanpanba.com/limit/2026-11-03).
- **2026-11-04 — rapid reversal:** a First Financial report described batch limit-down moves among several previously strong 羊／洋／阳 name stocks and noted that the move was not based on a common industrial trend. Source: [羊字辈概念炒作退潮](https://finance.eastmoney.com/a/202611043922207197.html).
- **2026-11-06 — 东方 name cluster:** a same-day report described multiple 东方-name stocks moving together while the broader market was weak; 东方海洋 was reported at 13 days / 8 boards intraday. Source: [A股“东方”系多股涨停](https://m.jrj.com.cn/madapter/stock/2026/11/06134759039826.shtml). A separate close review reported 758 advancers and 4,741 decliners for the full A-share universe, illustrating that a local name-theme rally did not equal broad-market strength. Source: [2026-11-06 close review](https://www.dabanke.com/?_canonical_recover=20260920).

Reported counts and prices can differ across sources because of timestamps, universe coverage, ST inclusion and whether a board is intraday or confirmed at close. The model must retain source and timestamp metadata rather than combine incompatible figures.

## Model interpretation

1. Name matching is a **lexical observation only**. It does not assert that the matched companies share products, customers, supply chains, earnings drivers or corporate relationships.
2. 东方海洋 can match both \`sheep_homophone\` (洋) and \`oriental_name\` (东方). Overlapping tags are intentional and must not double-count the stock within a single theme.
4. A single stock containing 狼 is not enough to establish a market-wide “狼字辈” theme. The current definition requires at least two matched members before a theme can move out of \`INACTIVE\`.
4. \`name_theme_heat_score\` and \`theme_diffusion_speed\` are attention diagnostics only. They do not add to \`opportunity_score\`.
5. \`speculative_exhaustion_risk\` requires at least three dated snapshots and a common constituent cohort. Without them it must remain \`NOT_MEASURABLE\`.
6. \`fundamental_overlap_score\` remains null until dated, verified evidence is mapped explicitly to a stock or theme. A name match is never treated as a fundamental catalyst.

## Historical validation status

**NOT_MEASURABLE for predictive performance.** The repository does not contain frozen full-universe stock observations for all four dates (Nov 3, 4, 5 and 6), nor does it contain the historical minute bars, auction snapshots, order-book changes or exact board labels needed to reconstruct intraday decisions. Public after-the-fact reviews cannot be used to infer what the model knew before the move.

Do not claim that V16 predicted the 羊／洋／阳 reversal or the 东方 cluster in advance. This case study defines a test scenario and documents the lexical rules; it does not establish alpha, hit rate or executable returns.

## Minimum data required to promote this module

- Daily full-universe rows with code, name, return, turnover amount, turnover rate, source timestamp and universe coverage.
- Point-in-time name history for renamed companies and delisted/suspended securities.
- Exact board/ST/new-listing-aware limit-up labels.
- At least 20–60 trading sessions for out-of-sample diffusion and exhaustion validation.
- Minute-level auction/open/first-15-minute data if any opening or intraday claim is tested.
- Frozen signal cohorts and matured T+1/T+3/T+5 returns after fees, slippage, T+1 and limit-lock constraints.

The V16 branch remains research-only. No production promotion is implied by this case study.
