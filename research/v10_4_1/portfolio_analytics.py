"""
V10.4.1.33 Portfolio Analytics

Research-only portfolio performance analytics.
"""


def calculate_returns(values):
    if len(values) < 2:
        return []
    return [(values[i] - values[i - 1]) / values[i - 1] for i in range(1, len(values)) if values[i - 1] != 0]


def max_drawdown(values):
    if not values:
        return 0
    peak = values[0]
    drawdown = 0
    for value in values:
        if value > peak:
            peak = value
        if peak:
            drawdown = max(drawdown, (peak - value) / peak)
    return drawdown


def win_rate(trades):
    if not trades:
        return 0
    wins = sum(1 for t in trades if t > 0)
    return wins / len(trades)


def summarize_portfolio(values, trades=None):
    return {
        "total_return": ((values[-1] - values[0]) / values[0]) if values else 0,
        "max_drawdown": max_drawdown(values),
        "win_rate": win_rate(trades or []),
        "samples": len(values),
    }
