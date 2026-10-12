"""
V10.4.1 Evaluation Dashboard
Research only module.
Aggregates backtest and forward evidence metrics.
"""


def calculate_metrics(trades):
    """Calculate core model evaluation metrics."""
    if not trades:
        return {
            "count": 0,
            "win_rate": 0,
            "average_return": 0,
            "max_drawdown": 0,
        }

    returns = [t.get("return", 0) for t in trades]
    wins = [r for r in returns if r > 0]

    equity = 1.0
    peak = 1.0
    max_drawdown = 0

    for r in returns:
        equity *= (1 + r)
        peak = max(peak, equity)
        drawdown = (peak - equity) / peak
        max_drawdown = max(max_drawdown, drawdown)

    return {
        "count": len(trades),
        "win_rate": len(wins) / len(trades),
        "average_return": sum(returns) / len(returns),
        "max_drawdown": max_drawdown,
    }


def compare_versions(old_result, new_result):
    """Compare model versions without assuming superiority."""
    return {
        "return_change": new_result.get("average_return", 0)
        - old_result.get("average_return", 0),
        "win_rate_change": new_result.get("win_rate", 0)
        - old_result.get("win_rate", 0),
        "drawdown_change": new_result.get("max_drawdown", 0)
        - old_result.get("max_drawdown", 0),
    }
