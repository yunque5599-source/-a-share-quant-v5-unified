"""
V10.4.1 Backtest Engine Prototype
Research only. Does not affect production trading logic.

Purpose:
- Evaluate forward returns of generated signals
- Compare model versions
- Track win rate, average return and drawdown
"""


def calculate_return(entry_price, exit_price):
    if not entry_price:
        return 0
    return (exit_price - entry_price) / entry_price


def evaluate_trades(trades):
    """Basic performance statistics."""
    if not trades:
        return {
            "count": 0,
            "win_rate": 0,
            "average_return": 0
        }

    returns = [t.get("return", 0) for t in trades]
    wins = [r for r in returns if r > 0]

    return {
        "count": len(trades),
        "win_rate": len(wins) / len(returns),
        "average_return": sum(returns) / len(returns)
    }


def compare_models(old_results, new_results):
    """Compare two model result sets."""
    return {
        "old_average": old_results.get("average_return", 0),
        "new_average": new_results.get("average_return", 0),
        "improvement": new_results.get("average_return", 0)
        - old_results.get("average_return", 0)
    }
