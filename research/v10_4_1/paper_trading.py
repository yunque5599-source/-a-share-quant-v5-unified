"""
V10.4.1 Paper Trading Simulator

Research-only simulation layer.
No brokerage connection and no real trading execution.
"""

from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class Position:
    code: str
    entry_price: float
    shares: int


@dataclass
class Portfolio:
    cash: float
    positions: Dict[str, Position] = field(default_factory=dict)
    history: List[dict] = field(default_factory=list)


def buy(portfolio: Portfolio, code: str, price: float, amount: float):
    if amount <= 0 or price <= 0:
        return False

    shares = int(amount / price / 100) * 100
    if shares <= 0 or shares * price > portfolio.cash:
        return False

    portfolio.cash -= shares * price
    portfolio.positions[code] = Position(code, price, shares)
    return True


def sell(portfolio: Portfolio, code: str, price: float):
    position = portfolio.positions.get(code)
    if not position:
        return False

    value = position.shares * price
    portfolio.cash += value
    portfolio.history.append(
        {
            "code": code,
            "entry": position.entry_price,
            "exit": price,
            "return": (price - position.entry_price) / position.entry_price,
        }
    )
    del portfolio.positions[code]
    return True


def portfolio_value(portfolio: Portfolio, prices: Dict[str, float]):
    value = portfolio.cash
    for code, position in portfolio.positions.items():
        value += position.shares * prices.get(code, position.entry_price)
    return value
