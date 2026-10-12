"""V10.4.1 Factor Attribution Analysis

Analyze which factors contribute to forward performance.
Research only module.
"""


def average_factor_values(samples, factor):
    values = [s.get(factor, 0) for s in samples]
    if not values:
        return 0
    return sum(values) / len(values)


def split_by_return(samples, threshold=0):
    winners = [s for s in samples if s.get("return", 0) > threshold]
    losers = [s for s in samples if s.get("return", 0) <= threshold]
    return winners, losers


def analyze_factors(samples, factors=None):
    if factors is None:
        factors = [
            "market_score",
            "sector_score",
            "fund_score",
            "momentum_score",
            "risk_score",
        ]

    winners, losers = split_by_return(samples)
    result = {}

    for factor in factors:
        result[factor] = {
            "winner_average": average_factor_values(winners, factor),
            "loser_average": average_factor_values(losers, factor),
        }

    return result


def rank_factor_importance(result):
    ranked = []
    for factor, values in result.items():
        gap = values["winner_average"] - values["loser_average"]
        ranked.append({"factor": factor, "importance": gap})

    return sorted(ranked, key=lambda x: x["importance"], reverse=True)
