"""V10.4.1 forward evidence reporting prototype."""


def summarize(records):
    total = len(records)
    if total == 0:
        return {
            "signals": 0,
            "win_rate": 0,
            "avg_return": 0,
        }

    wins = [r for r in records if r.get("return", 0) > 0]
    avg = sum(r.get("return", 0) for r in records) / total

    return {
        "signals": total,
        "win_rate": round(len(wins) / total, 4),
        "avg_return": round(avg, 4),
    }
