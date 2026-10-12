"""
V10.4.1 Model Drift Detection

Research-only module for monitoring strategy degradation.
"""


def calculate_win_rate_change(current_rate, baseline_rate):
    return current_rate - baseline_rate


def detect_factor_drift(current_factors, baseline_factors, threshold=0.15):
    """Detect large factor contribution changes."""
    drift = {}
    for key, value in current_factors.items():
        base = baseline_factors.get(key, value)
        drift[key] = {
            "change": value - base,
            "drift": abs(value - base) >= threshold,
        }
    return drift


def detect_model_drift(metrics, thresholds=None):
    """Return drift warnings from recent performance metrics."""
    thresholds = thresholds or {
        "win_rate_drop": -0.1,
        "drawdown_increase": 0.1,
    }

    warnings = []

    if metrics.get("win_rate_change", 0) <= thresholds["win_rate_drop"]:
        warnings.append("win_rate_decline")

    if metrics.get("drawdown_change", 0) >= thresholds["drawdown_increase"]:
        warnings.append("drawdown_expansion")

    return {
        "drift": len(warnings) > 0,
        "warnings": warnings,
    }
