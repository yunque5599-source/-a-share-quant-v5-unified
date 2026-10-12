"""
V10.4.1 Confidence Engine
Research module only.
Calibrates signal confidence using model consistency factors.
"""


def calculate_confidence(market_score, sector_score, stock_score, fund_score, risk_score):
    """Return confidence score from 0-100."""
    score = (
        market_score * 0.20
        + sector_score * 0.20
        + stock_score * 0.25
        + fund_score * 0.25
        + risk_score * 0.10
    )

    return round(max(0, min(100, score)), 2)


def classify_confidence(confidence):
    if confidence >= 85:
        return "A"
    if confidence >= 70:
        return "B"
    if confidence >= 55:
        return "C"
    return "D"


def apply_confidence_penalty(signal, confidence):
    """Reduce aggressive signals when confidence is insufficient."""
    if signal == "BUY" and confidence < 70:
        return "WATCH"
    return signal
