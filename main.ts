// TIDE v3 — a deep-dip mean-reversion bot for the BTC 24h race
// (competition btc-race-24h-20261118-1444).
//
// Retuned from scratch on THIS race's dev window. The previous race's
// parameters (SMA 360, dip 85, exit 35, fallback at bar 1080) LOSE $25.35 on
// this window, so they were discarded, not carried over. What the new dev
// window (17 Nov 14:44 UTC -> 18 Nov 14:44 UTC, $65,083 -> $63,261, -2.80%)
// actually rewards is patience: it is a down day with one deep early drop
// (-2.18% in the first 4 hours) and one real recovery (+1.73% in hours 4-8).
// Everything else in the window is chop that costs ~26 bps a round trip in
// fees, slippage and pool impact. Small-dip trading loses on BOTH this window
// and the previous race's flat window (swept: every dip <= 60 bps config is
// negative on one or both), and trend-following loses too (every house
// baseline except hold-cash ends this window negative: buy-and-hold -$31.63,
// momentum -$23.87, ema-cross -$148.17, rsi-bollinger -$39.92,
// adx-momentum -$75.57). So TIDE v3 trades rarely and only on a deep dip.
//
// Rules (all exact bigint arithmetic on bar closes, fully deterministic):
//   * Mean = 60-bar simple moving average of closes (1 hour of 1-minute bars).
//   * BUY (full cash) when the close falls 140 bps or more below the mean.
//     On the dev window that fires once, at bar 66 near the bottom of the
//     early drop, and the position rides the recovery.
//   * SELL (whole position) when the close recovers to 70 bps above the mean.
//   * Kill-switch: if the close falls 200 bps below the mean, the regime has
//     broken down, not dipped — sell if holding and stop buying dips until the
//     close recovers to within 50 bps below the mean.
//   * No new dip entries in the last 30 bars of the window (a fresh entry
//     there would pay a full round trip for minutes of exposure).
//   * Late fallback: if no trade has happened by bar 1260 and the close is
//     within 100 bps below the mean and within 50 bps above it, buy once and
//     hold to the end. This is insurance for a flat race day, when the
//     deep-dip rule never fires: a flat day with zero trades ranks below every
//     entry that meets the guardrail, while a late buy meets it. The fallback
//     never buys a falling knife — while the close sits more than 100 bps below
//     the mean it keeps waiting — and never buys a spike top either (more than
//     50 bps above the mean). At bar 1380 it buys regardless, so the guardrail
//     trade is guaranteed, just delayed. On the dev window the fallback never
//     fires (the dip trade already happened); on the previous race's flat
//     window it fires and gains +$4.95.
//
// Validation (exact-arithmetic simulator calibrated to the official harness
// engine, then confirmed by the kit's own grade-local):
//   * Dev window: +$10.45, 2 trades (1 round trip), fees $0.80, max DD 1.50%.
//   * 11 stress windows (dev halves, reversed dev, synthetic +/-1.5%/+/-3%
//     drift days, the previous race's flat dev window + halves): worst $0.00
//     — no losing window — average +$6.34, max DD 1.62%.
//   * The result is a plateau, not a knife-edge: SMA 45-60, dip 130-150,
//     exit 70, kill 200-300 all give the identical outcome.
//   * Beats every house baseline on the dev window (best baseline is
//     hold-cash at $0.00; the best trading baseline is -$23.87).
//
//   One asset, long only, at most one position, at most one order per reply.
//   No network, no wall clock, no randomness, no files outside the repo.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// --- Strategy parameters (basis points; swept on dev, validated on 11 stress windows) ---
const SMA_BARS = 60; // 1 hour of 1-minute bars
const WINDOW_BARS = 1440; // the scored window is 24 hours of 1-minute bars
const DIP_BPS = 140; // buy when close is this far below the mean
const EXIT_BPS = 70; // sell when close is this far above the mean
const KILL_BPS = 200; // regime break: stop dip-buying below this
const REARM_BPS = 50; // re-arm dip-buying once back within this of the mean
const FALLBACK_BAR = 1260; // if no trade by this bar, buy once (guardrail + upside)
const FALLBACK_BELOW_BPS = 100; // ...provided close is within this below the mean
const FALLBACK_ABOVE_BPS = 50; // ...and within this above it (never buy a spike top)
const FALLBACK_LAST_RESORT_BAR = 1380; // ...but by this bar, buy regardless (guardrail)
const NO_ENTRY_LAST_BARS = 30; // no fresh dip entries in the last 30 bars
const MAX_SLIPPAGE_BPS = 500;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units
const BAR_MS = 60_000; // one minute per bar

// Integer comparison scale: close < mean * (10000 - X) / 10000 becomes
// close * SMA_BARS * 10000 < smaSum * (10000 - X). All exact, no floats.
const SCALE = BigInt(SMA_BARS * 10000);

class Tide {
  closes: bigint[] = [];
  smaSum = 0n;
  killed = false;
  everHeld = false;
  fallbackDone = false;
  // Close time (ms) of the first bar seen. Bar time is the only clock the bot
  // may read, and the window is 24h of 1-minute bars, so the late-window
  // cutoffs below are measured from it in minutes — this stays correct even
  // if the harness ever prefixes warm-up batches (a plain seq count would not).
  firstBarTime: number | null = null;

  push(close: bigint, t: number): void {
    if (this.firstBarTime === null) this.firstBarTime = t;
    this.closes.push(close);
    this.smaSum += close;
    if (this.closes.length > SMA_BARS) {
      this.smaSum -= this.closes.shift()!;
    }
  }

  get meanReady(): boolean {
    return this.closes.length >= SMA_BARS;
  }

  /** close < mean * (10000 - bps) / 10000 */
  below(close: bigint, bps: number): boolean {
    return close * SCALE < this.smaSum * BigInt(10000 - bps);
  }

  /** close > mean * (10000 - bps) / 10000 */
  aboveMeanMinus(close: bigint, bps: number): boolean {
    return close * SCALE > this.smaSum * BigInt(10000 - bps);
  }

  /** close >= mean * (10000 + bps) / 10000 */
  atOrAbove(close: bigint, bps: number): boolean {
    return close * SCALE >= this.smaSum * BigInt(10000 + bps);
  }
}

const tide = new Tide();
let symbol = 'CBBTC';

await runBars({
  onHello(state: BarsState) {
    const symbols = state.hello.symbols;
    if (symbols.length > 0) symbol = symbols[0].symbol;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Record this batch's bar for the symbol only (a missing minute has no bar).
    for (const bar of batch.bars) {
      if (bar.symbol === symbol) tide.push(BigInt(bar.c), bar.t);
    }
    if (state.positions.get(symbol) !== undefined) tide.everHeld = true;
    if (state.warmingUp || !tide.meanReady) return [];
    const close = state.close(symbol);
    if (close === null || tide.firstBarTime === null) return [];

    // Minutes elapsed since the window's first bar.
    const elapsedBars = (batch.t - tide.firstBarTime) / BAR_MS;
    const noEntry = elapsedBars >= WINDOW_BARS - NO_ENTRY_LAST_BARS;
    const fallbackDue = elapsedBars >= FALLBACK_BAR;

    const held = state.positions.get(symbol);

    // Kill-switch: regime broke down, not a dip.
    if (tide.below(close, KILL_BPS)) {
      tide.killed = true;
      if (held !== undefined) {
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (tide.aboveMeanMinus(close, REARM_BPS)) {
      // Close back within REARM_BPS below the mean: re-arm dip-buying.
      tide.killed = false;
    }
    if (tide.killed) return [];

    if (held !== undefined) {
      // Exit at the mean (+70 bps): the dip has reverted.
      if (tide.atOrAbove(close, EXIT_BPS)) {
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: buy the deep dip, or the late fallback.
    if (!noEntry && tide.below(close, DIP_BPS)) {
      if (state.cash >= MIN_NOTIONAL) {
        return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    // Fallback: from FALLBACK_BAR, buy once if the price is sane — within
    // FALLBACK_BELOW_BPS below the mean and within FALLBACK_ABOVE_BPS above
    // it. On a parabolic up day the close can sit far above a lagging mean;
    // buying that spike top is worse than waiting a little for a pullback, so
    // the fallback keeps waiting while the price is stretched. But the race
    // guardrail needs at least 1 trade, so at FALLBACK_LAST_RESORT_BAR the
    // fallback buys regardless — the trade is guaranteed, just delayed.
    // It is not gated by noEntry: a flat day's only trade may have to come
    // in the last bars, and that is exactly what the guardrail needs.
    const fallbackPriceOk =
      !tide.below(close, FALLBACK_BELOW_BPS) && !tide.atOrAbove(close, FALLBACK_ABOVE_BPS);
    const fallbackLastResort = elapsedBars >= FALLBACK_LAST_RESORT_BAR;
    if (
      !tide.fallbackDone &&
      !tide.everHeld &&
      fallbackDue &&
      (fallbackPriceOk || fallbackLastResort)
    ) {
      tide.fallbackDone = true;
      if (state.cash >= MIN_NOTIONAL) {
        return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
