"""
V10.4.1 Research Pipeline Runner
Research-only orchestration layer.
Does not execute trades or modify production rules.
"""

from datetime import datetime


def run_pipeline(market_data=None, stock_pool=None):
    """Run research workflow and return structured outputs."""
    return {
        "version": "V10.4.1",
        "timestamp": datetime.utcnow().isoformat(),
        "market": market_data or {},
        "stock_pool_size": len(stock_pool or []),
        "signals": [],
        "status": "research_only"
    }


def build_daily_snapshot(result):
    """Create immutable-style research snapshot payload."""
    return {
        "version": result.get("version"),
        "timestamp": result.get("timestamp"),
        "signals": result.get("signals", []),
    }
