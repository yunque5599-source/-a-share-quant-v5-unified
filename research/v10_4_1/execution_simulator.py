"""
V10.4.1 Execution Simulator
Research only. Simulates execution frictions for A-share short-term strategy validation.
"""


def apply_slippage(price, side="BUY", slippage=0.001):
    if side == "BUY":
        return price * (1 + slippage)
    return price * (1 - slippage)


def apply_fee(amount, commission=0.0003, stamp_tax=0.001, side="SELL"):
    fee = amount * commission
    if side == "SELL":
        fee += amount * stamp_tax
    return fee


def can_execute(change_percent, limit_up=False, limit_down=False):
    if limit_up or limit_down:
        return False
    return True


def simulate_trade(buy_price, sell_price, quantity=100, buy_slippage=0.001, sell_slippage=0.001):
    executed_buy = apply_slippage(buy_price, "BUY", buy_slippage)
    executed_sell = apply_slippage(sell_price, "SELL", sell_slippage)

    buy_amount = executed_buy * quantity
    sell_amount = executed_sell * quantity

    cost = apply_fee(buy_amount, side="BUY")
    revenue_fee = apply_fee(sell_amount, side="SELL")

    return {
        "buy_price": executed_buy,
        "sell_price": executed_sell,
        "gross_return": (executed_sell - executed_buy) / executed_buy,
        "net_profit": sell_amount - buy_amount - cost - revenue_fee
    }
