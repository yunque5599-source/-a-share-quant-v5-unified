"""
V10.4.1.31 Production Readiness Check
Research-only validation gate before paper trading or production review.
"""


def check_sample_size(samples, minimum=100):
    return {
        "passed": samples >= minimum,
        "samples": samples,
        "minimum": minimum,
    }


def check_drawdown(max_drawdown, limit=0.20):
    return {
        "passed": max_drawdown <= limit,
        "max_drawdown": max_drawdown,
        "limit": limit,
    }


def check_overfitting(train_return, test_return, max_gap=0.15):
    gap = abs(train_return - test_return)
    return {
        "passed": gap <= max_gap,
        "gap": gap,
        "limit": max_gap,
    }


def run_readiness_check(metrics):
    checks = {
        "sample": check_sample_size(metrics.get("samples", 0)),
        "drawdown": check_drawdown(metrics.get("max_drawdown", 1)),
        "overfit": check_overfitting(
            metrics.get("train_return", 0),
            metrics.get("test_return", 0),
        ),
    }

    ready = all(item["passed"] for item in checks.values())

    return {
        "status": "READY" if ready else "NOT_READY",
        "checks": checks,
    }
