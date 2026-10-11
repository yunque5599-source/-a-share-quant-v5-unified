import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from risk_filter import risk_check


def test_normal_risk_passes():
    result = risk_check(10, 1.5)
    assert result["allow_buy"] is True


def test_extreme_risk_blocks():
    result = risk_check(60, 5)
    assert result["allow_buy"] is False
