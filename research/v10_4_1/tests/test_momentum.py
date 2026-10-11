import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from momentum_engine import calculate_momentum, momentum_signal


def test_momentum_score_high():
    score = calculate_momentum(90, 90, 90)
    assert score == 90
    assert momentum_signal(score) == "strong"


def test_momentum_score_watch():
    score = calculate_momentum(70, 80, 75)
    assert momentum_signal(score) in ("watch", "strong")
