"""V10.4.1 score engine prototype.
Research only. No production dependency.
"""


def calculate_score(momentum, fund, structure, risk):
    """Combine research factors into a 0-100 score."""
    score = (
        momentum * 0.35
        + fund * 0.25
        + structure * 0.20
        + risk * 0.20
    )
    return round(max(0, min(100, score)), 2)


def rating(score):
    if score >= 90:
        return "A+"
    if score >= 85:
        return "A"
    if score >= 75:
        return "B"
    return "C"
