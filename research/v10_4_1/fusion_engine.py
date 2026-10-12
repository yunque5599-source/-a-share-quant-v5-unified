"""
V10.4.1 Signal Fusion Engine
Research module only. Does not modify production trading logic.

Combines market, sector, stock, fund and risk signals into one interpretable score.
"""


def clamp(value, low=0, high=100):
    return max(low, min(high, value))


def fuse_scores(market_score, sector_score, stock_score, fund_score, risk_score):
    """Generate final research score."""
    score = (
        market_score * 0.15
        + sector_score * 0.25
        + stock_score * 0.25
        + fund_score * 0.20
        + risk_score * 0.15
    )
    return round(clamp(score), 2)


def generate_signal(final_score, confidence=None):
    if final_score >= 90:
        signal = "BUY"
    elif final_score >= 75:
        signal = "WATCH"
    else:
        signal = "AVOID"

    return {
        "signal": signal,
        "score": final_score,
        "confidence": confidence,
    }


def detect_conflict(stock_score, sector_score, fund_score):
    """Detect strong stock with weak supporting environment."""
    warnings = []

    if stock_score >= 85 and sector_score < 50:
        warnings.append("weak_sector_support")

    if stock_score >= 85 and fund_score < 50:
        warnings.append("weak_fund_support")

    return warnings
