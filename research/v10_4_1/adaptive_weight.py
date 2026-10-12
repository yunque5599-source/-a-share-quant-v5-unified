"""
V10.4.1.29 Adaptive Weight Engine
Research-only module.

Purpose:
Use validated forward performance statistics to suggest factor weight
adjustments while avoiding short-term overfitting.
"""

MIN_SAMPLE_SIZE = 30
MAX_WEIGHT_CHANGE = 0.05


def clamp(value, low, high):
    return max(low, min(high, value))


def suggest_weight_adjustment(factor_stats, current_weights, min_samples=MIN_SAMPLE_SIZE):
    """Suggest small factor weight changes based on factor contribution.

    factor_stats example:
    {
        "sector_score": {"contribution": 0.12, "samples": 100},
        "fund_score": {"contribution": 0.08, "samples": 100}
    }
    """
    if not factor_stats:
        return current_weights.copy()

    new_weights = current_weights.copy()
    valid = []

    for factor, stat in factor_stats.items():
        if stat.get("samples", 0) >= min_samples:
            valid.append((factor, stat.get("contribution", 0)))

    if not valid:
        return new_weights

    avg = sum(x[1] for x in valid) / len(valid)

    for factor, contribution in valid:
        if factor not in new_weights:
            continue
        delta = clamp((contribution - avg) * 0.1, -MAX_WEIGHT_CHANGE, MAX_WEIGHT_CHANGE)
        new_weights[factor] = clamp(new_weights[factor] + delta, 0, 1)

    total = sum(new_weights.values())
    if total > 0:
        for factor in new_weights:
            new_weights[factor] = new_weights[factor] / total

    return new_weights


def validate_change(before, after, max_change=MAX_WEIGHT_CHANGE):
    """Check whether weight changes remain within safety limits."""
    for key in before:
        if abs(after.get(key, 0) - before[key]) > max_change:
            return False
    return True
