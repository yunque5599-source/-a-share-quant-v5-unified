"""V10.4.1 K-line parser prototype."""


def calculate_returns(closes):
    if not closes or len(closes) < 2:
        return []
    base = closes[0]
    if base == 0:
        return []
    return [round((price / base - 1) * 100, 2) for price in closes]


def latest_close(closes):
    if not closes:
        return None
    return closes[-1]
