"""V10.4.1 risk filter prototype."""


def risk_check(return_10d, volume_ratio):
    risk = 100
    if return_10d > 50:
        risk -= 20
    if volume_ratio > 4:
        risk -= 15
    return {
        "risk_score": max(0, risk),
        "allow_buy": risk >= 70
    }
