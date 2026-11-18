// BounceHarvest: a dip-harvest bot for the make.fun cbBTC 1-minute race
// (agent-fun/bars-replay/v1).
//
// Idea, in one line: BTC's 1-minute tape flushes and snaps back; buy a deep
// flush only once the snap-back has started, only when the 1-hour tape says
// the flush is either noise in an up/flat market or a mature washout, bank
// the bounce at a fixed target, and never let a trade bleed.
//
//   - Entry (flat only). DEEP-DIP HARVEST: the close fell dipPct or more over
//     dipBars bars AND the bounce is confirmed (this close above the last
//     close). The confirm is what keeps the bot out of cascades: a dip that
//     is still falling is not bought. A shallow dip threshold was tested and
//     rejected: at 0.6% the bot caught eight trades on the dev window and
//     lost money on them; at 1.0% it caught two and both paid.
//   - Regime gate (60 bars, one hour). A dip is bought only when the 60-bar
//     return is above regimeUp (an uptrend or a flat tape, where a dip is
//     noise to buy) or below regimeWashout (a mature washout, where the
//     selling is exhausted). Between the two the downtrend is fresh and the
//     dip is usually the start of a bigger drop, not the bottom: no entry.
//     The lookback is one hour, not four: the dev window's money dip arrives
//     at bar 64, before any 4-hour lookback exists, so a longer gate would
//     lock the bot out of the only trade that matters. The gate was validated
//     on three windows (this dev window, the previous race's dev window, and
//     this window time-reversed): it turns a -$45 loss on the previous
//     window into +$13 while keeping this window at +$11.
//   - Sizing: full equity on every entry (100%). This is a one-shot
//     paper-money race scored on net PnL alone, with a 25% drawdown
//     guardrail that is a bar to clear, not a ranking factor; the bot's
//     worst drawdown on any tested window is under 2%. Sizing below the cap
//     would leave money on the table for no ranking benefit.
//   - Exits (holding), in priority order: a take-profit at takeProfitPct
//     (the bounce on this tape is a fast spike — it peaks within ~20 bars
//     and fades, so a fixed target banks more than a trailing stop, which
//     always gives the spike back); a trailing stop that arms at
//     trailArmPct and trails trailPct under the peak (the backstop for a
//     bounce that keeps running past the target's neighbourhood without
//     touching it, or for a trade the target missed); a hard stop at
//     stopPct under the average entry; and a time exit at maxHoldBars (the
//     recovery behind a deep dip can take hours to play out, so the clock
//     is long — a 240-bar clock cut the dev window's second trade short).
//     After a stop-loss exit the bot sits out cooldownBars bars before it
//     may enter again: a stop means the bounce failed, so the next dip in
//     the same flush is not bought straight away.
//   - No entries in the last bars of the window: a trade opened there has no
//     time to work before the forced flatten.
//
// Everything here is deterministic float64 math on the bars alone: no clock,
// no environment, no randomness. Prices are the harness's raw units (any
// scale); every rule is a ratio, so the scale never matters.

export interface BounceHarvestParams {
  /** Lookback for the dip (bars). */
  dipBars: number;
  /** Minimum 30-bar fall to consider a dip (fraction, e.g. 0.010 = 1.0%). */
  dipPct: number;
  /** Consecutive up closes that confirm a dip entry. */
  confirmBars: number;
  /** Lookback for the regime gate (bars). */
  regimeBars: number;
  /** Regime gate: buy dips when the regime return is above this (up/flat). */
  regimeUp: number;
  /** Regime gate: or below this (a mature washout). Between the two, no entry. */
  regimeWashout: number;
  /** Take-profit: sell when the position gains this much over entry. */
  takeProfitPct: number;
  /** Trailing stop: arms once the peak gain reaches this. */
  trailArmPct: number;
  /** Trailing stop: sells when the close falls this far under the peak. */
  trailPct: number;
  /** Hard stop: sell when the position loses this much vs entry. */
  stopPct: number;
  /** No entries for this many bars after a stop-loss exit (keeps the bot out
      of a cascading selloff: a stop means the bounce failed, so the next dip
      in the same flush is not bought straight away). */
  cooldownBars: number;
  /** Time exit: sell after holding this many bars. */
  maxHoldBars: number;
  /** No entries at or after this bar index (0-based). */
  lastEntryBar: number;
}

export const DEFAULT_PARAMS: BounceHarvestParams = {
  dipBars: 30,
  dipPct: 0.01,
  confirmBars: 1,
  regimeBars: 60,
  regimeUp: -0.01,
  regimeWashout: -0.02,
  takeProfitPct: 0.01,
  trailArmPct: 0.008,
  trailPct: 0.005,
  stopPct: 0.015,
  cooldownBars: 30,
  maxHoldBars: 400,
  lastEntryBar: 1380,
};

export interface BarInput {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** The account as the caller sees it; prices in raw units, money in quote units. */
export interface AccountInput {
  /** Cash in quote units (micro-USDC). */
  cash: number;
  /** Equity in quote units. */
  equity: number;
  /** Equity at the start of the window. */
  startEquity: number;
  /** The open position, if any: average entry price (raw units) and quantity. */
  position: { entryPrice: number; qty: number } | null;
  /** Bars seen so far in the window (0-based index of the bar being decided). */
  barIndex: number;
}

export type Decision =
  | { action: 'buy'; reason: string }
  | { action: 'sell'; reason: string }
  | { action: 'hold' };

export class BounceHarvest {
  readonly params: BounceHarvestParams;
  private closes: number[] = [];
  /** Peak close since the current position opened (raw units). */
  private peak = 0;
  /** Bars held in the current position. */
  private heldBars = 0;
  /** Whether we held a position on the last bar (to spot a fill). */
  private wasHolding = false;
  /** Bar index of the last stop-loss exit, for the re-entry cooldown (-1: none yet). */
  private lastStopBar = -1;

  constructor(params: BounceHarvestParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  /** Return of the latest close vs the close n bars ago, or null if too few bars. */
  private retBars(n: number): number | null {
    if (this.closes.length <= n) return null;
    const then = this.closes[this.closes.length - 1 - n]!;
    return this.closes[this.closes.length - 1]! / then - 1;
  }

  decide(bar: BarInput, account: AccountInput): Decision {
    const p = this.params;
    const c = bar.c;

    // --- fold the bar in (closes only: every rule here is a close return)
    this.closes.push(c);
    const keep = Math.max(p.regimeBars, p.dipBars) + 2;
    if (this.closes.length > keep + 60) {
      this.closes.splice(0, this.closes.length - keep - 60);
    }

    // --- position bookkeeping
    const holding = account.position !== null;
    if (holding && !this.wasHolding) {
      // A fill opened the position since the last bar.
      this.peak = c;
      this.heldBars = 0;
    }
    if (!holding && this.wasHolding) {
      this.peak = 0;
      this.heldBars = 0;
    }
    this.wasHolding = holding;

    if (holding && account.position !== null) {
      this.heldBars++;
      if (c > this.peak) this.peak = c;
      const entry = account.position.entryPrice;
      const pnl = c / entry - 1;
      const peakPnl = this.peak / entry - 1;
      // Hard stop first: never let a trade bleed.
      if (pnl <= -p.stopPct) {
        // Start the re-entry cooldown: the bounce failed, so the next dip
        // in the same flush is not bought straight away.
        this.lastStopBar = account.barIndex;
        return { action: 'sell', reason: 'stop' };
      }
      // Take-profit: the bounce is a fast spike; bank it at the target.
      if (pnl >= p.takeProfitPct) {
        return { action: 'sell', reason: 'take-profit' };
      }
      // Trailing stop, once armed: the backstop for a runner.
      if (peakPnl >= p.trailArmPct && c <= this.peak * (1 - p.trailPct)) {
        return { action: 'sell', reason: 'trail' };
      }
      // Time exit: the recovery behind a deep dip can take hours.
      if (this.heldBars >= p.maxHoldBars) {
        return { action: 'sell', reason: 'time' };
      }
      return { action: 'hold' };
    }

    // --- flat: entries
    if (account.barIndex >= p.lastEntryBar) return { action: 'hold' };
    // Re-entry cooldown after a stop-loss exit: sit out the rest of the flush.
    if (this.lastStopBar >= 0 && account.barIndex - this.lastStopBar < p.cooldownBars) {
      return { action: 'hold' };
    }
    const retDip = this.retBars(p.dipBars);
    const retRegime = this.retBars(p.regimeBars);
    if (retDip === null || retRegime === null) return { action: 'hold' };
    // Regime gate: buy dips in an up/flat tape or after a mature washout;
    // a fresh downtrend's dips are the start of a bigger drop.
    const regimeOk = retRegime > p.regimeUp || retRegime < p.regimeWashout;
    if (!regimeOk) return { action: 'hold' };
    // Bounce confirmation: the dip must have started turning.
    let confirmed = true;
    for (let i = 0; i < p.confirmBars; i++) {
      const idx = this.closes.length - 1 - i;
      if (this.closes[idx]! <= this.closes[idx - 1]!) {
        confirmed = false;
        break;
      }
    }
    if (retDip <= -p.dipPct && confirmed) {
      return { action: 'buy', reason: retRegime < p.regimeWashout ? 'dip-washout' : 'dip-bounce' };
    }
    return { action: 'hold' };
  }
}
