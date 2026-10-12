"""
V10.4.1 Automated Research Report Generator
Research only. Does not modify production trading logic.
"""

from datetime import datetime


def generate_report(metrics=None, signals=None, market_state=None):
    metrics = metrics or {}
    signals = signals or []
    market_state = market_state or {}

    return {
        "version": "V10.4.1",
        "generated_at": datetime.utcnow().isoformat(),
        "market": market_state,
        "signal_count": len(signals),
        "metrics": {
            "win_rate": metrics.get("win_rate", 0),
            "average_return": metrics.get("average_return", 0),
            "max_drawdown": metrics.get("max_drawdown", 0)
        },
        "signals": signals
    }


def format_summary(report):
    return {
        "version": report.get("version"),
        "signal_count": report.get("signal_count"),
        "win_rate": report.get("metrics", {}).get("win_rate"),
        "average_return": report.get("metrics", {}).get("average_return")
    }
