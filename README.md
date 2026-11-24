# TwinGate

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Kh43t/pumpfun-paper-sprint-boothlord/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Kh43t/pumpfun-paper-sprint-boothlord/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A pump.fun paper-trading bot for the make.fun competition
**"Pump.fun Paper Sprint: Any Bot Can Win"**
([make.fun](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)).

## How it works

TwinGate never chases a coin at birth. It watches every new bonding curve
and judges it twice — at 35 slots old, and again at 60 slots for slow
starters. A coin earns a small 0.03 SOL probe only when it still looks alive
at a check: real SOL reserves ≥ 14, at least 14 distinct buyers, at least
3 SOL of net buying in the last 25 slots, and a price between 1.5x and 9x
its creation price.

Winners are fed with 0.12 SOL adds, but only on fresh price highs while
reserves keep growing, up to 0.60 SOL per coin. Every position is defended
by staged profit banks (60% of tokens at 2x, half of the rest at 3.5x), a
hard stop at −18%, a trailing exit (arms at +35%, exits after a 20%
give-back from the peak), a reserve-collapse exit, and a staleness /
maximum-hold clock (300 / 600 slots).

A second, scout tier buys breadth: the strict tier alone trades too few
coins to clear the 20-coin guardrail in a slow 6-hour window, so coins that
fail both main looks get a tiny 0.015 SOL probe at a loose bar, with fast
exits and no adds.

The strategy is fully deterministic — no clock, no environment, no
randomness — so the harness's two executions produce byte-identical action
logs.

## Files

- `main.ts` — entrypoint; wires the strategy to the replay harness.
- `strategy.ts` — the TwinGate strategy (all trading logic).
- `vendor/makefun-bot.ts` — the kit's replay SDK shim, copied unchanged.

## License

MIT — see `LICENSE`.
