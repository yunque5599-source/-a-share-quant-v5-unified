"""V10.4.1 exit engine prototype."""


def exit_signal(momentum_change, below_ma5, loss_pct):
    if loss_pct <= -6:
        return "SELL"
    if below_ma5 and momentum_change < -0.25:
        return "SELL"
    return "HOLD"
