[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oy-builds/pump-replay-bot-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oy-builds/pump-replay-bot-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Steady Tape — a filtered-momentum pump.fun replay bot

Steady Tape trades the `agent-fun/replay/v2` pump.fun replay with 10 SOL of paper money. It only
buys curves that are past their launch phase and show broad, sustained buy pressure over a rolling
48-slot tape: several distinct buyers, net SOL flowing in, and price rising but still near its
window high. Every position is one fixed-fraction stake (4.5% of starting capital, clipped by
the 1%-of-real-reserve order cap) — no pyramiding, no martingale, no averaging down, and a
curve is never re-entered once traded.

Exits are layered and mechanical: a hard stop-loss, a half-size take-profit, a trailing stop once
a position has run, a fade exit when recent flow turns negative, and a maximum holding time. A
portfolio drawdown guard stops new entries after a deep equity drawdown, total exposure is
capped, and small pacing probes keep the bot on track for the 20-coin round-trip guardrail.
The bot is fully deterministic: no clock, no randomness, no network — decisions depend only on
the batch stream.
