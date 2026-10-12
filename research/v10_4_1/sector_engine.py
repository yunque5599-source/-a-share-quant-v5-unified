"""
V10.4.1 Sector Strength Engine
Research module only. Does not affect production logic.

Purpose:
Evaluate sector strength and provide an additional context score
for short-term stock ranking.
"""


def calculate_sector_score(
    sector_return=0,
    limit_up_count=0,
    volume_growth=0,
    active_days=0,
):
    """Calculate sector momentum score (0-100)."""
    score = 0

    # Sector price momentum
    if sector_return >= 5:
        score += 30
    elif sector_return >= 2:
        score += 20
    elif sector_return > 0:
        score += 10

    # Short-term capital activity
    if limit_up_count >= 10:
        score += 30
    elif limit_up_count >= 5:
        score += 20
    elif limit_up_count > 0:
        score += 10

    # Volume confirmation
    if volume_growth >= 50:
        score += 20
    elif volume_growth >= 20:
        score += 10

    # Continuity
    if active_days >= 3:
        score += 20
    elif active_days >= 2:
        score += 10

    return min(score, 100)


def combine_stock_sector_score(stock_score, sector_score):
    """Combine individual stock strength with sector strength."""
    return round(stock_score * 0.7 + sector_score * 0.3, 2)
