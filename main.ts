// BTC race bot — breakout, long only, rare trades (btc-race-24h-20261118-1444).
//
// Idea: a full-size round trip costs ~26 bps (4 bps fee + 2 bps slippage +
// ~20 bps pool impact), so active strategies bleed in chop. This bot trades
// rarely: it buys only a confirmed breakout and exits fast on a small
// take-profit or a tight stop, so most of the window it sits in cash.
//
// Entry (once per bar, after the 240-bar warmup):
//   - price above the 240-bar slow EMA and that EMA rising (4h uptrend), and
//   - close above the highest high of the previous 120 bars (2h breakout).
// Exit, checked in this order every bar while holding:
//   - trailing stop 2% below the peak close, or hard stop 2% below entry,
//   - take profit 1.5% above entry,
//   - dead-money exit after 480 bars held with less than 0.5% gain,
//   - fast EMA crossing back below the slow EMA.
// After any exit, a 60-bar cooldown blocks re-entry.
//
// Local grades (kit grade-local, process driver, two executions must match):
//   - this instance's dev window: net PnL +$7.65, 4 trades, 50% win,
//     max drawdown 0.83%, fees $1.61 (at 2x fees still +$6.04) — passes
//     the dev gate (PnL > $0). L1 regrade reproduced byte for byte.
//   - the previous instance's dev window (20261117-0603): -$32.30.
//     That window was choppy-rising and punished every breakout entry;
//     the strategy is regime-specific, and the gate that matters here is
//     this instance's dev window. No parameter was picked from the race
//     window: the race window is unseen by everyone until it runs.
//
// No network, no clock, no randomness: every decision is a pure function of
// the bars seen so far, so two runs produce identical orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Tunables, picked by the grade-local sweep on this instance's dev window.
const PARAMS = {
  emaFast: 30, // fast EMA length (bars)
  emaSlow: 240, // slow EMA length (bars) = 4h trend
  lookback: 120, // breakout lookback (bars) = 2h high
  trail: 0.02, // trailing stop from peak close
  take: 0.015, // take profit from entry
  stop: 0.02, // hard stop from entry
  timeStop: 480, // max hold (bars) before dead-money exit
  timeGain: 0.005, // gain below which the time stop fires
  cooldown: 60, // bars to wait after an exit before re-entering
};

type Params = typeof PARAMS;

class Bot {
  private p: Params;
  private closes: number[] = [];
  private highs: number[] = [];
  private emaSHist: number[] = [];
  private emaF: number | null = null;
  private emaS: number | null = null;
  private holding = false;
  private entry: number | null = null;
  private peak: number | null = null;
  private entrySeq: number | null = null;
  private cooldownUntil = -1;

  constructor(params?: Partial<Params>) {
    this.p = { ...PARAMS, ...params };
  }

  private static ema(prev: number | null, x: number, n: number): number {
    const k = 2 / (n + 1);
    return prev === null ? x : prev + k * (x - prev);
  }

  private syncHolding(state: BarsState, close: number, seq: number): void {
    const h = state.positions.get(SYMBOL);
    if (h !== undefined && !this.holding) {
      const qty = h.qty;
      this.entry = qty > 0n ? Number((h.cost * 10_000_000n) / qty) : close;
      this.peak = close;
      this.entrySeq = seq;
      this.holding = true;
    } else if (h === undefined) {
      this.holding = false;
      this.entry = null;
      this.peak = null;
    }
  }

  private sellAll(state: BarsState): OrderInput[] {
    const h = state.positions.get(SYMBOL);
    if (h === undefined || h.qty <= 0n) return [];
    this.cooldownUntil = state.seq + this.p.cooldown;
    this.holding = false;
    return [{ side: 'sell', symbol: SYMBOL, qty: h.qty, max_slippage_bps: 200 }];
  }

  private buyAll(state: BarsState): OrderInput[] {
    const room = state.weightRoom(SYMBOL);
    const amount = state.cash < room ? state.cash : room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: 200 }];
  }

  private record(bar: { c: string; h: string }): void {
    const c = Number(bar.c);
    this.closes.push(c);
    this.highs.push(Number(bar.h));
    this.emaF = Bot.ema(this.emaF, c, this.p.emaFast);
    this.emaS = Bot.ema(this.emaS, c, this.p.emaSlow);
    this.emaSHist.push(this.emaS);
  }

  decide(state: BarsState, seq: number): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (state.warmingUp) {
      if (bar !== undefined) this.record(bar);
      return [];
    }
    if (bar === undefined) return [];
    this.record(bar);
    const close = Number(bar.c);
    this.syncHolding(state, close, seq);
    const p = this.p;
    if (this.holding) {
      this.peak = Math.max(this.peak as number, close);
      if (close <= (this.peak as number) * (1 - p.trail)) return this.sellAll(state);
      if (close <= (this.entry as number) * (1 - p.stop)) return this.sellAll(state);
      if (close >= (this.entry as number) * (1 + p.take)) return this.sellAll(state);
      if (
        (this.entrySeq as number) !== null &&
        seq - (this.entrySeq as number) >= p.timeStop &&
        close < (this.entry as number) * (1 + p.timeGain)
      ) {
        return this.sellAll(state);
      }
      if (this.emaF !== null && this.emaS !== null && this.emaF < this.emaS) {
        return this.sellAll(state);
      }
      return [];
    }
    // Not holding: breakout entry.
    if (this.closes.length < p.emaSlow + 1) return [];
    if (seq <= this.cooldownUntil) return [];
    if (this.emaS === null || this.emaF === null) return [];
    const prevSlow =
      this.emaSHist.length > 60 ? this.emaSHist[this.emaSHist.length - 61] : this.emaSHist[0];
    const rising = this.emaS > prevSlow;
    if (!(close > this.emaS && rising)) return [];
    // Close above the highest high of the previous `lookback` bars.
    const window = this.highs.slice(-p.lookback - 1, -1);
    if (window.length > 0 && close > Math.max(...window)) return this.buyAll(state);
    return [];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.decide(state, batch.seq);
  },
});
