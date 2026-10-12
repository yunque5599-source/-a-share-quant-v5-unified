"""V10.4.1 market adapter prototype.
Research only. Does not modify production market APIs.
"""


def normalize_market_record(record):
    """Normalize external market data into V10.4.1 internal format."""
    return {
        "code": record.get("code"),
        "close": record.get("close", []),
        "volume": record.get("volume", []),
        "high": record.get("high", []),
        "low": record.get("low", [])
    }
