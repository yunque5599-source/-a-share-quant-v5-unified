# V17 One-Click Selection — Research Protocol

## Purpose

V17 is a research-only selection surface designed around the user's stated 1–4 week horizon: identify an improving industry before it becomes an obvious momentum leader, then find individual stocks showing early trend structure, multi-session capital-flow persistence and controlled pullbacks.

V17 does not replace the production V15 selector. It is a shadow application and always returns `SHADOW_NO_ORDERS`. It never submits orders or generates a buy price, stop, target or position size.

## Selection funnel

1. **Full-market cross-sectional prefilter.** Rank the current Eastmoney universe using daily main-flow estimate, daily price extension, 60-day return, turnover, liquidity and same-day industry breadth. The deep-scan prefilter currently supports Shanghai/Shenzhen codes beginning 0, 3 and 6; Beijing-exchange code families are excluded until a verified K-line adapter exists. Exclude ST/delisting-name rows, low-turnover-value rows, extreme daily moves and high-turnover rows. This is a recall-oriented funnel only.
2. **Deep daily-bar scan.** Union the reconstructed V15 Stage1 Top50 with the separate V17 early-flow prefilter Top30, de-duplicate by code, and fetch up to 80 unadjusted daily K-line histories. Shenzhen ChiNext codes beginning with `3` are mapped to the Shenzhen K-line market. Unsupported exchange/code families remain outside the deep scan.
3. **Early-trend classification.** Reuse the V16 deterministic daily trend engine: MA5/10/20 turns, MA ordering/reclaim, first 20/60-day resistance break, ATR compression/expansion, close location, 5/10-day returns and overheat penalties.
4. **Stock funding evidence.** Require three qualified point-in-time observations, at least two positive main-flow observations and higher lows. Institutional LHB is kept separate to avoid double-counting the same disclosure.
5. **Flow-price response.** Compare three-session vendor-estimated main flow with turnover, price response and higher-low structure. Flat-to-moderate gains with persistent inflow and higher lows can be labelled an absorption-style proxy; a strong inflow accompanied by a material price decline is flagged as weak response; a sharp multi-day rise is treated as extension risk. This is a research proxy, not proof of institutional accumulation.
6. **Industry funding evidence.** Aggregate industry main-flow/amount ratio, positive-flow share, advancing share and return over three and five qualified sessions. Three-session persistence requires at least two positive-flow sessions; five-session persistence requires at least three. A single-day inflow is labelled `ONE_DAY_INFLOW` or `PARTIAL_ONE_DAY_INFLOW`; it is not persistence or a bottom signal.
7. **Entry timing and risk gates.** Score daily-bar setups such as early breakout, constructive low-volume pullback, reacceleration and tight consolidation. Penalize acceleration, overextension, distribution, limit-up chase and market risk. Minute bars, auction, VWAP and Level-2 events remain unavailable.
8. **Output.** Return Top10/30/50 research rankings plus separate potential-start, triggered, confirmed, no-chase and invalidated pools. Missing components are omitted, never silently filled with neutral values.

## Initial research weights

| Component | Maximum weight |
|---|---:|
| Early trend | 30 |
| Three-session stock funding persistence | 20 |
| Three-session flow-price response | 10 |
| Industry pulse / persistence | 10 / 20 |
| Relative strength | 10 |
| Daily-bar entry timing | 5 |
| Liquidity | 5 |

When only a one-day industry pulse is available, it receives at most 10 points of weight; the missing persistence half is not imputed. The displayed composite is a normalized research rank over observed components and includes a separate coverage ratio. The flow-price response and entry-timing factors are separate from raw flow magnitude: flow must be checked against price response, higher lows and extension. The composite is not a probability and has not been calibrated.

## Data quality gates

- Full-market qualification requires a finalized close, complete upstream pages, at least 99% reported universe coverage and at least 500 observed rows.
- Stock funding persistence only uses the two most recent prior snapshots when both are qualified, plus the current qualified close. Industry 3-session persistence uses the same three-session window; 5-session persistence requires the four most recent prior snapshots plus the current qualified close. A partial snapshot in the relevant recent window blocks that persistence claim.
- The V17 deep-scan candidate universe is the union of V15 Stage1 Top50 and V17 early-flow prefilter Top30. It is not a full-market 65-bar scan; the UI must disclose this.
- Daily main-flow is a vendor-derived estimate, not proof of institutional holdings or account-level cash inflow.
- Minute bars, auction, VWAP, Level-2 add/cancel/execute events, point-in-time news and fundamental coverage are not connected in this release. They remain `NOT_MEASURABLE`.
- A vendor limit-up pool is an observation proxy. It is not exchange-certified order-book evidence.
- Synthetic tests validate deterministic code paths only. They do not establish predictive performance.

## Historical replay and promotion gates

The V17 replay compares the full supported V17 funnel, the overlapping V17 main-board subset, reconstructed V15 Stage1 and a simple 60-day momentum baseline. Signal features are frozen after the signal-date close; the earliest modeled entry is the next qualified archived session open. Net returns subtract a transparent 21-basis-point round-trip cost proxy. The archive currently does not carry an official exchange trading calendar, so T+1/T+3/T+5 are counted as next qualified archived snapshots and are not independently calendar-verified.

V17 remains shadow-only until:
- at least 20 matured signal dates per Top-K and horizon;
- at least 95% selected-candidate outcome coverage;
- V17 flow-price response and entry-timing factors show stable out-of-sample contribution rather than only improving in-sample ranking;
- time-ordered rolling out-of-sample evaluation with leakage controls;
- fees, slippage, suspensions, T+1 sellability, limit-lock fills and corporate actions are handled;
- V17 is compared with V15 and simple momentum/breakout baselines on the same signal dates and candidate budget;
- recall, precision, T+1/T+3/T+5 returns, excess return, drawdown, MFE/MAE and turnover are reported separately.

No synthetic fixture or one partial market snapshot can satisfy these gates. No Production merge/deployment, production weight change or trading authorization is implied by this branch.
