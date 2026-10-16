# V12 Psychology Specification

## Objective

Psychology is a short-horizon market-behavior layer, not a narrative generator and not a substitute for Alpha.

V12 combines:

- Alpha: stock-level return opportunity.
- Timing: entry-state quality.
- Psychology: whether the crowd, capital and narrative environment can support continuation without excessive chase risk.

Current V12 formula:

V12TradeScore = Alpha * 0.60 + Timing * 0.25 + Psychology * 0.15

## Psychology components

| Component | Weight | Purpose |
|---|---:|---|
| EmotionHeat | 20% | Current theme capital inflow, price strength and breadth |
| EmotionAcceleration | 20% | Change in theme return, capital, breadth and limit-up participation |
| Narrative | 20% | Novelty, credibility, propagation, persistence and expectation gap |
| Leader | 20% | Whether the stock is the theme leader/core/front-runner |
| Imagination | 10% | Market size, penetration gap, policy runway, technology optionality and company capture |
| Behavioral | 10% | Capital-price alignment, crowd participation, FOMO balance and leader alignment |

## Behavioral layer

The behavioral layer intentionally does not mean "more emotion is always better".

It distinguishes:

1. **Capital-price alignment**: positive capital flow accompanying positive price response is constructive; divergence is penalized.
2. **Crowd participation**: broad participation is stronger than a single-stock spike.
3. **FOMO balance**: moderate excitement is preferred; panic and euphoric crowding are both penalized.
4. **Leader alignment**: a candidate should remain reasonably consistent with the theme leader rather than becoming an isolated chase.

This is deliberately conservative because sentiment can attract flows without necessarily predicting returns, while high-attention/ambiguous news can also generate overreaction.

## Narrative and imagination evidence gate

Narrative and imagination cannot be invented from the model's intuition.

A research block is complete only when:

- all required sub-scores exist;
- the evidence is dated and available at or before the candidate as-of time;
- at least two evidence items are present;
- complete is not explicitly false.

If the evidence gate fails, Psychology remains incomplete and the candidate cannot enter V12 trading ranking.

## Leader rule

Leader status is evidence, not a hard override.

The score can use:

- explicit theme leader code;
- candidate rank within theme;
- leader status;
- leader persistence;
- candidate/leader relative strength.

A stock cannot enter Top1 solely because its narrative is attractive.

## Anti-lookahead rules

- Theme/news timestamps must not be later than the candidate as-of date.
- Market regime uses only data available at as-of.
- Future price bars are used only for T+1/T+3/T+5 outcome measurement.
- OOS validation keeps chronological folds isolated.
- No validation result changes production weights automatically.

## OOS acceptance gate

The Psychology layer is not considered validated merely because one aggregate backtest improves.

Before production consideration, require:

1. V12 vs Composite comparison on the same replay engine.
2. Multiple chronological OOS folds.
3. Positive or non-negative uplift in the majority of folds, not only the aggregate.
4. Improvement that survives transaction costs.
5. No material deterioration in maximum drawdown.
6. Performance is not confined to one market regime.
7. Psychology Top1/Top5 results remain directionally useful.
8. No future-data leakage in news, theme, leader or market-regime fields.

Synthetic fixtures are unit/integration tests only. They are never evidence of live profitability.

## Live validation policy

Real-money validation is a separate phase after the historical OOS gate.

The first live phase should be treated as model verification, not profit maximization:

- no leverage;
- no use of emergency cash;
- no automatic scale-up because of early profits;
- every signal is logged with the full Alpha/Timing/Psychology decomposition;
- actual fills, slippage and rejected orders are recorded;
- the model is allowed to say WAIT when evidence is incomplete.

A live result cannot retroactively be used to tune the same day's signal.
