"""V10.4.1 forward evidence tracker prototype.
Research only. Tracks realized returns after signal capture.
"""


def calculate_forward_return(entry_price, future_price):
    if not entry_price:
        return 0.0
    return round((future_price - entry_price) / entry_price * 100, 4)


def track_signal(signal, future_prices):
    """Append T+1/T+3/T+5 performance to a captured signal."""
    entry = signal.get("buy_price", 0)
    result = dict(signal)

    for key in ("t1", "t3", "t5"):
        price = future_prices.get(key)
        result[f"return_{key}"] = calculate_forward_return(entry, price) if price else None

    return result


def summarize_results(records):
    valid = [r for r in records if r.get("return_t5") is not None]
    if not valid:
        return {"count": 0, "win_rate": 0}

    wins = [r for r in valid if r["return_t5"] > 0]
    return {
        "count": len(valid),
        "win_rate": round(len(wins) / len(valid) * 100, 2)
    }
