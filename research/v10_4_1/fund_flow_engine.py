"""
V10.4.1 Fund Flow Engine
Research module only.

Purpose:
Estimate short-term capital activity quality.
Does not generate live trading orders.
"""


def normalize_score(value, low, high):
    if value <= low:
        return 0
    if value >= high:
        return 100
    return int((value - low) / (high - low) * 100)


def calculate_fund_flow_score(data):
    """Calculate short-term capital strength score.

    Inputs:
    volume_ratio: current volume / average volume
    turnover_rate: percentage
    active_buy_ratio: estimated active buying ratio
    big_order_flow: normalized large order flow
    """
    volume_score = normalize_score(
        data.get("volume_ratio", 1), 0.8, 3
    )

    turnover = data.get("turnover_rate", 0)
    if 5 <= turnover <= 20:
        turnover_score = 100
    elif turnover > 35:
        turnover_score = 30
    else:
        turnover_score = 60

    active_buy_score = normalize_score(
        data.get("active_buy_ratio", 0.5), 0.3, 0.7
    )

    big_order_score = normalize_score(
        data.get("big_order_flow", 0), -1, 1
    )

    score = (
        volume_score * 0.30
        + turnover_score * 0.20
        + active_buy_score * 0.30
        + big_order_score * 0.20
    )

    return {
        "fund_flow_score": round(score, 2),
        "level": "strong" if score >= 75 else "normal" if score >= 50 else "weak"
    }
