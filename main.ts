// BTC race bot — breakout, long only, rare trades (btc-race-24h-20261118-1444).
//
// Why this shape: a full-size round trip costs about 26 bps (4 bps fee +
// 2 bps slippage + roughly 20 bps of pool impact), so a bot that trades
// often bleeds to death in chop. This bot does the opposite: it waits in
// cash for a confirmed breakout, takes a small profit quickly, and cuts
// losers fast. Most of the window it does nothing at all.
//
// Entry, checked once per bar after the 240-bar warmup:
//   1. the close sits above the 240-bar slow EMA (the 4-hour trend), and
//      that slow EMA is rising versus 60 bars ago;
//   2. the close prints above the highest high of the previous 120 bars
//      (a genuine 2-hour breakout, not a single-bar wick).
// Exit, checked in this order on every bar while a position is open:
//   1. trailing stop, 2% below the highest close since entry;
//   2. hard stop, 2% below the entry close;
//   3. take profit, 1.5% above the entry close;
//   4. dead-money exit: held 480 bars (8 hours) with under 0.5% gain;
//   5. the fast EMA crossing back below the slow EMA.
// After any exit the bot waits 60 bars before it may enter again.
//
// Local grades (kit grade-local, process driver, two executions must match):
//   - this instance's dev window: net PnL +$7.65, 4 trades, 50% win,
//     max drawdown 0.83%, fees $1.61 (at 2x fees still +$6.04) — passes
//     the dev gate (net PnL above $0). L1 regrade reproduced byte for byte.
//   - the previous instance's dev window (20261117-0603): -$32.30. That
//     window was choppy-rising and punished every breakout entry, so this
//     strategy is regime-specific; the gate that matters for racing is
//     this instance's dev window, and no parameter was picked from the
//     race window, which is unseen by everyone until it runs.
//
// Determinism: no network, no clock, no randomness. Every decision is a
// pure function of the bars seen so far, so two runs produce identical
// orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Tunables, picked by the grade-local sweep on this instance's dev window.
const PARAMS = {
  emaFast: 30, // fast EMA length in bars
  emaSlow: 240, // slow EMA length in bars (4 hours of trend)
  lookback: 120, // breakout lookback in bars (2-hour high)
  trail: 0.02, // trailing stop, fraction below the peak close
  take: 0.015, // take profit, fraction above the entry close
  stop: 0.02, // hard stop, fraction below the entry close
  timeStop: 480, // max hold in bars before the dead-money exit
  timeGain: 0.005, // gain below which the time stop fires
  cooldown: 60, // bars to wait after an exit before re-entering
};

type Params = typeof PARAMS;

class BreakoutBot {
  private p: Params;
  private closeSeries: number[] = [];
  private highSeries: number[] = [];
  private slowEmaSeries: number[] = [];
  private fastEma: number | null = null;
  private slowEma: number | null = null;
  private inPosition = false;
  private entryClose: number | null = null;
  private peakClose: number | null = null;
  private entryBar: number | null = null;
  private noEntryBefore = -1;

  constructor(params?: Partial<Params>) {
    this.p = { ...PARAMS, ...params };
  }

  private static ema(prev: number | null, x: number, n: number): number {
    const k = 2 / (n + 1);
    return prev === null ? x : prev + k * (x - prev);
  }

  // Keep the position bookkeeping in sync with the replay's actual
  // holdings: if the replay shows a position we did not record (for
  // example a fill from an earlier order), adopt it as our entry.
  private refreshPosition(state: BarsState, close: number, seq: number): void {
    const h = state.positions.get(SYMBOL);
    if (h !== undefined && !this.inPosition) {
      const qty = h.qty;
      this.entryClose = qty > 0n ? Number((h.cost * 10_000_000n) / qty) : close;
      this.peakClose = close;
      this.entryBar = seq;
      this.inPosition = true;
    } else if (h === undefined) {
      this.inPosition = false;
      this.entryClose = null;
      this.peakClose = null;
    }
  }

  private sellEverything(state: BarsState): OrderInput[] {
    const h = state.positions.get(SYMBOL);
    if (h === undefined || h.qty <= 0n) return [];
    this.noEntryBefore = state.seq + this.p.cooldown;
    this.inPosition = false;
    return [{ side: 'sell', symbol: SYMBOL, qty: h.qty, max_slippage_bps: 200 }];
  }

  private buyWithCash(state: BarsState): OrderInput[] {
    const room = state.weightRoom(SYMBOL);
    const amount = state.cash < room ? state.cash : room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: 200 }];
  }

  private noteBar(bar: { c: string; h: string }): void {
    const c = Number(bar.c);
    this.closeSeries.push(c);
    this.highSeries.push(Number(bar.h));
    this.fastEma = BreakoutBot.ema(this.fastEma, c, this.p.emaFast);
    this.slowEma = BreakoutBot.ema(this.slowEma, c, this.p.emaSlow);
    this.slowEmaSeries.push(this.slowEma);
  }

  // While holding, test the exits in their fixed order. Returns the exit
  // orders, or [] when no exit fires and the position stays open.
  private exitOrders(state: BarsState, close: number, seq: number): OrderInput[] {
    const p = this.p;
    this.peakClose = Math.max(this.peakClose as number, close);
    if (close <= (this.peakClose as number) * (1 - p.trail)) return this.sellEverything(state);
    if (close <= (this.entryClose as number) * (1 - p.stop)) return this.sellEverything(state);
    if (close >= (this.entryClose as number) * (1 + p.take)) return this.sellEverything(state);
    const heldLong =
      (this.entryBar as number) !== null && seq - (this.entryBar as number) >= p.timeStop;
    const deadMoney = close < (this.entryClose as number) * (1 + p.timeGain);
    if (heldLong && deadMoney) return this.sellEverything(state);
    if (this.fastEma !== null && this.slowEma !== null && this.fastEma < this.slowEma) {
      return this.sellEverything(state);
    }
    return [];
  }

  // While flat, test the breakout entry. Returns the buy order, or [].
  private entryOrders(state: BarsState, close: number, seq: number): OrderInput[] {
    const p = this.p;
    if (this.closeSeries.length < p.emaSlow + 1) return [];
    if (seq <= this.noEntryBefore) return [];
    if (this.slowEma === null || this.fastEma === null) return [];
    // The slow EMA must be rising: compare it with its value 60 bars ago.
    const prevSlow =
      this.slowEmaSeries.length > 60
        ? this.slowEmaSeries[this.slowEmaSeries.length - 61]
        : this.slowEmaSeries[0];
    const rising = this.slowEma > prevSlow;
    if (!(close > this.slowEma && rising)) return [];
    // The close must beat the highest high of the previous `lookback` bars.
    const window = this.highSeries.slice(-p.lookback - 1, -1);
    if (window.length > 0 && close > Math.max(...window)) return this.buyWithCash(state);
    return [];
  }

  decide(state: BarsState, seq: number): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (state.warmingUp) {
      if (bar !== undefined) this.noteBar(bar);
      return [];
    }
    if (bar === undefined) return [];
    this.noteBar(bar);
    const close = Number(bar.c);
    this.refreshPosition(state, close, seq);
    if (this.inPosition) return this.exitOrders(state, close, seq);
    return this.entryOrders(state, close, seq);
  }
}

const bot = new BreakoutBot();

await runBars({
  onBatch(state, batch) {
    return bot.decide(state, batch.seq);
  },
});
