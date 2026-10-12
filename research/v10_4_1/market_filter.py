"""
V10.4.1 Market Regime Filter
Research module only.
Does not affect production signals.
"""


def moving_average(values, window):
    if len(values) < window:
        return None
    return sum(values[-window:]) / window


def calculate_market_regime(market_data):
    """Return market state and position factor.

    Input:
    {
        "index_close": [],
        "advance_count": int,
        "decline_count": int,
        "limit_up_count": int
    }
    """
    score = 50

    closes = market_data.get("index_close", [])
    ma5 = moving_average(closes, 5)
    ma10 = moving_average(closes, 10)

    if ma5 and ma10:
        if closes[-1] > ma5 > ma10:
            score += 25
        elif closes[-1] < ma10:
            score -= 25

    advance = market_data.get("advance_count", 0)
    decline = market_data.get("decline_count", 0)

    total = advance + decline
    if total:
        breadth = advance / total
        if breadth > 0.6:
            score += 15
        elif breadth < 0.3:
            score -= 15

    limit_up = market_data.get("limit_up_count", 0)
    if limit_up >= 80:
        score += 10
    elif limit_up < 30:
        score -= 10

    score = max(0, min(100, score))

    if score >= 70:
        regime = "BULL"
        position_factor = 1.0
    elif score >= 40:
        regime = "NEUTRAL"
        position_factor = 0.6
    else:
        regime = "BEAR"
        position_factor = 0.3

    return {
        "regime": regime,
        "score": score,
        "position_factor": position_factor
    }
