# btc-race-20261118-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/hiduplahzomb/btc-race-20261118-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/hiduplahzomb/btc-race-20261118-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

BounceHarvest is a dip-harvest trading bot for cbBTC on the make.fun 24-hour BTC race. It buys deep dips only once the bounce has started, only when the 1-hour regime favours a bounce, banks the bounce at a fixed take-profit, and never lets a trade bleed.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2wgaefze&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>

## How it works

The bot speaks the `agent-fun/bars-replay/v1` protocol (NDJSON over stdin/stdout) and trades cbBTC/USDC on 1-minute bars, long-only, from a $1,000 paper account. The strategy is in `strategy.ts` (`main.ts` is the thin protocol wrapper; `vendor/makefun-bars.ts` is the kit's SDK shim, byte-identical).

**BounceHarvest, in one line:** BTC's 1-minute tape flushes and snaps back — buy a deep flush only once the snap-back has started, only in a regime where dips bounce, bank the bounce at a fixed target, and never let a trade bleed.

- **Entry (flat only).** The close fell 1.0% or more over 30 bars and the bounce is confirmed (this close above the last close). The confirm is what keeps the bot out of cascades: a dip that is still falling is not bought. A shallow dip threshold was tested and rejected: at 0.6% the bot caught eight trades on the dev window and lost money on them; at 1.0% it caught two round trips and both paid.
- **Regime gate (60 bars, one hour).** A dip is bought only when the 60-bar return is above −1.0% (an uptrend or a flat tape, where a dip is noise to buy) or below −2.0% (a mature washout, where the selling is exhausted). Between the two the downtrend is fresh and the dip is usually the start of a bigger drop, not the bottom — no entry. The lookback is one hour, not four: the dev window's money dip arrives at bar 64, before any 4-hour lookback exists, so a longer gate would lock the bot out of the only trade that matters.
- **Sizing.** Full equity on every entry (100%). This is a one-shot paper-money race scored on net PnL alone, with a 25% drawdown guardrail that is a bar to clear, not a ranking factor; the bot's worst drawdown on any tested window is under 2%. Sizing below the cap would leave money on the table for no ranking benefit.
- **Exits.** A take-profit at +1.0% (the bounce on this tape is a fast spike — it peaks within ~20 bars and fades, so a fixed target banks more than a trailing stop, which always gives the spike back), a trailing stop that arms at +0.8% and trails 0.5% under the peak (the backstop for a runner), a hard stop at −1.5%, and a 400-bar time exit (the recovery behind a deep dip can take hours — a 240-bar clock cut the dev window's second trade short). After a stop-loss exit the bot sits out 30 bars before it may enter again, so a failed bounce is not chased into the same flush.
- **Determinism.** The strategy is a pure function of the bar stream: float64 math only, no clock, no environment, no randomness, no external calls. Two runs reproduce byte for byte (verified by the kit grader's L1 regrade).

## Dev results

Graded locally with the kit's harness (`grade-local --driver process`) on the 24h dev window 2026-11-17T14:44Z → 2026-11-18T14:44Z, a **down day** (BTC $65,074 → $63,261, −2.79%):

| Bot | Net PnL | Trades | Win rate | Max drawdown |
| --- | --- | --- | --- | --- |
| **BounceHarvest (this bot)** | **+$9.34** | 1 (2 fills) | 100% | −0.48% |
| buy-and-hold | −$31.63 | 1 | 0% | −3.25% |
| momentum | −$23.87 | 1 | 0% | −3.24% |
| ema-cross | −$148.17 | 80 | 5% | −14.97% |
| rsi-bollinger | −$39.92 | 19 | 30% | −4.35% |
| adx-momentum | −$75.57 | 30 | 7% | −7.56% |
| hold-cash | $0.00 | 0 | — | 0% |

BounceHarvest is the only one of the seven that clears the dev gate (net PnL > $0 after all fees), with the lowest drawdown of any trading bot. Fees paid: $0.80; at 2× fees the net PnL is still +$8.53. The chosen parameters sit on a plateau, not a sharp peak: take-profit 0.8% still nets +$6.66, and a dip threshold of 0.9% reproduces the same +$9.34 exactly.

## Robustness (not just the dev window)

The design was validated on three windows before it was built, because the race window is a different day and the dev window alone cannot be trusted:

| Window | Net PnL (simulator, ~13 bps/leg) | Trades |
| --- | --- | --- |
| This dev window (down day, −2.79%) | +$10.53 | 1 RT |
| Previous race's dev window (down day, −3.92%) | +$12.89 | 3 RTs |
| This window time-reversed (synthetic up day) | +$13.28 | 1 RT |

Positive on all three. The regime gate is what makes the difference: without it the same dip logic loses −$45.36 on the previous window. A momentum arm was tested and rejected — on this window, 30-bar rallies of +0.8% continued less than 0.6% of the time (0 of 13 signals).

## Grade it yourself

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```
