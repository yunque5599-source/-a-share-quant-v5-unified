"""
V10.4.1.27 Forward Monitor
Track generated research signals and evaluate future performance.
Research only. No trading execution.
"""

from datetime import datetime


def create_monitor_record(signal, prices=None):
    prices = prices or {}
    buy_price = signal.get("buy_price")

    record = {
        "code": signal.get("code"),
        "signal": signal.get("signal", "WATCH"),
        "score": signal.get("score", 0),
        "created_at": datetime.utcnow().isoformat(),
        "buy_price": buy_price,
        "future_prices": prices,
    }

    if buy_price and prices:
        for key, value in prices.items():
            record[f"return_{key}"] = round((value - buy_price) / buy_price, 4)

    return record


def summarize_forward(records):
    if not records:
        return {"count": 0, "win_rate": 0}

    valid = [r for r in records if "return_t5" in r]
    wins = [r for r in valid if r["return_t5"] > 0]

    return {
        "count": len(valid),
        "win_rate": round(len(wins) / len(valid), 4) if valid else 0,
    }
