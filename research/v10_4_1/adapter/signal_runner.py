"""V10.4.1 signal runner prototype.
Combines research modules without production dependency.
"""

from ..momentum_engine import calculate_momentum
from ..risk_filter import risk_check
from ..score_engine import calculate_score


def run_signal(data):
    momentum = calculate_momentum(
        data.get("m1", 0),
        data.get("m3", 0),
        data.get("m5", 0)
    )

    risk = risk_check(
        data.get("return_10d", 0),
        data.get("volume_ratio", 1)
    )

    score = calculate_score(
        momentum,
        data.get("fund", 0),
        data.get("structure", 0),
        risk["risk_score"]
    )

    return {
        "momentum": momentum,
        "risk": risk,
        "score": score
    }
