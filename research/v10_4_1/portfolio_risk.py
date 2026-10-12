"""
V10.4.1 Portfolio Risk Management Engine
Research only. Does not execute trades.
"""


def position_factor(regime="NEUTRAL"):
    """Return maximum exposure factor by market regime."""
    factors = {
        "BULL": 1.0,
        "NEUTRAL": 0.6,
        "BEAR": 0.3,
    }
    return factors.get(regime, 0.5)


def calculate_position_size(score, risk_level="medium"):
    """Basic position suggestion based on signal quality and risk."""
    if score >= 90 and risk_level == "low":
        return 0.3
    if score >= 80:
        return 0.2
    if score >= 70:
        return 0.1
    return 0


def loss_streak_control(loss_count):
    """Reduce exposure after consecutive losses."""
    if loss_count >= 3:
        return 0.5
    if loss_count >= 2:
        return 0.75
    return 1.0


def sector_concentration_check(sector_weight, limit=0.4):
    """Prevent excessive exposure to one sector."""
    return sector_weight <= limit


def risk_adjust_position(base_position, regime, loss_count):
    return base_position * position_factor(regime) * loss_streak_control(loss_count)
