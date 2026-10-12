"""
V10.4.1 Parameter Optimizer
Research only. No production trading integration.

Purpose:
- evaluate parameter combinations
- avoid selecting parameters only by highest return
- consider return, drawdown and stability
"""

from itertools import product


def generate_parameter_space(space):
    keys = list(space.keys())
    values = [space[k] for k in keys]
    return [dict(zip(keys, combo)) for combo in product(*values)]


def evaluate_parameter_set(params, evaluator):
    result = evaluator(params)
    score = (
        result.get("return", 0) * 0.5
        - result.get("drawdown", 0) * 0.3
        + result.get("stability", 0) * 0.2
    )
    return {
        "params": params,
        "result": result,
        "optimization_score": score,
    }


def rank_parameters(results):
    return sorted(
        results,
        key=lambda x: x.get("optimization_score", 0),
        reverse=True,
    )
