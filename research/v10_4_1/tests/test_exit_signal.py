import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from exit_signal import exit_signal


def test_loss_exit():
    assert exit_signal(0, False, -6) == "SELL"


def test_normal_hold():
    assert exit_signal(0, False, -1) == "HOLD"


def test_trend_break_exit():
    assert exit_signal(-0.3, True, -2) == "SELL"
