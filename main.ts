// BounceHarvest entrypoint: speaks agent-fun/bars-replay/v1 through the
// kit's SDK shim and hands every CBBTC bar to the strategy in strategy.ts.
//
// The harness sends hello once, then one batch per minute (the bar that just
// closed, the fills of the orders decided on the previous batch, and the
// account), then done. This file answers every batch with exactly one reply
// echoing its seq. Orders decided on a bar fill at the next bar's open, so
// every decision here is made on closes the bot has already seen.
//
// Sizing: the strategy is all-in by design (see strategy.ts), so a buy
// spends the whole cash balance, capped by the position-weight room the
// harness allows. A sell always empties the position.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';
import { BounceHarvest, type AccountInput, type BarInput } from './strategy.ts';

const MAX_SLIPPAGE_BPS = 100;

const strategy = new BounceHarvest();
let barsSeen = 0;
let startEquity = 0n;

await runBars({
  onHello(state) {
    startEquity = BigInt(state.hello.capital.quote_units);
  },

  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (bar === undefined) return [];
    if (state.warmingUp) return [];
    barsSeen++;

    const symbol = state.symbols.get('CBBTC')!;
    // Average entry price in raw price units: cost (quote units) over qty
    // (base units), rescaled by 10^(qty_scale + price_scale - quote_scale).
    const scaleExp = symbol.qty_scale + symbol.price_scale - state.hello.capital.quote_scale;
    const held = state.positions.get('CBBTC');
    const position =
      held !== undefined && held.qty > 0n
        ? {
            entryPrice: Number((held.cost * 10n ** BigInt(scaleExp)) / held.qty),
            qty: Number(held.qty),
          }
        : null;

    const account: AccountInput = {
      cash: Number(state.cash),
      equity: Number(state.equity),
      startEquity: Number(startEquity),
      position,
      barIndex: barsSeen - 1,
    };
    const input: BarInput = { o: Number(bar.o), h: Number(bar.h), l: Number(bar.l), c: Number(bar.c) };
    const decision = strategy.decide(input, account);

    if (decision.action === 'sell' && held !== undefined && held.qty > 0n) {
      const order: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    if (decision.action === 'buy') {
      // All-in: spend the cash, capped by the weight room.
      let notional = state.cash;
      const room = state.weightRoom('CBBTC');
      if (notional > room) notional = room;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      const order: BuyInput = {
        side: 'buy',
        symbol: 'CBBTC',
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [order];
    }
    return [];
  },
});
