"""V10.4.1 Momentum Engine prototype.
Research only. No production dependency.
"""


def calculate_momentum(m1, m3, m5):
    score = m1 * 0.25 + m3 * 0.45 + m5 * 0.30
    return round(max(0, min(100, score)), 2)


def momentum_signal(score):
    if score >= 85:
        return "strong"
    if score >= 75:
        return "watch"
    return "avoid"
