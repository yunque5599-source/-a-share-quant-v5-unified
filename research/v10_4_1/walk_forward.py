"""
V10.4.1 Walk Forward Validation
Research module only.

Purpose:
Validate whether strategy performance is stable across different market windows.
"""


def create_windows(data, train_size, test_size, step=1):
    windows = []
    start = 0
    while start + train_size + test_size <= len(data):
        train = data[start:start + train_size]
        test = data[start + train_size:start + train_size + test_size]
        windows.append({"train": train, "test": test})
        start += step
    return windows


def evaluate_window(window, evaluator):
    result = evaluator(window["train"], window["test"])
    return {
        "train_size": len(window["train"]),
        "test_size": len(window["test"]),
        "result": result,
    }


def run_walk_forward(data, evaluator, train_size=180, test_size=30, step=30):
    results = []
    for window in create_windows(data, train_size, test_size, step):
        results.append(evaluate_window(window, evaluator))
    return results
