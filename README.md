[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/cupucepu/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/cupucepu/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# TIDE v3 — BTC 24h race bot

A deep-dip mean-reversion bot for the make.fun competition
[btc-race-24h-20261118-1444](https://make.fun/bounty/btc-race-24h-20261118-1444).
It trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, long
only, starting from 1,000 USDC of paper money.

## Idea

Retuned from scratch on this race's dev window (17 Nov 14:44 UTC → 18 Nov
14:44 UTC, $65,083 → $63,261, −2.80%). The previous race's parameters
(SMA 360, dip 85 bps, exit 35 bps, fallback at bar 1080) lose **−$25.35** on
this window, so they were discarded. This window is a down day with one deep
early drop (−2.18% in the first 4 hours) and one real recovery (+1.73% in
hours 4–8); everything else is chop that costs ~26 bps a round trip. Small-dip
trading loses on both this window and the previous race's flat window, and
trend-following loses too — every house baseline except hold-cash ends this
window negative. So TIDE v3 trades rarely, and only on a deep dip.

## Rules

- Mean = 60-bar simple moving average of closes (1 hour of 1-minute bars).
- **Buy** (full cash) when the close falls **140 bps or more below the mean**.
  On the dev window that fires once, at bar 66 near the bottom of the early
  drop, and rides the recovery.
- **Sell** (whole position) when the close recovers to **70 bps above the
  mean**.
- **Kill-switch:** close 200 bps below the mean means the regime broke, not
  dipped — sell if holding, stop buying dips until the close is back within
  50 bps below the mean.
- No new dip entries in the last 30 bars.
- **Late fallback:** if no trade has happened by bar 1260 and the close is
  within 100 bps below the mean, buy once and hold to the end. Insurance for
  a flat race day, when the deep-dip rule never fires: a flat day with zero
  trades ranks below every entry that meets the ≥1-trade guardrail. The
  fallback never buys a falling knife — while the close sits more than 100 bps
  below the mean it keeps waiting, and if it never comes back, it never buys.

All decisions use exact bigint arithmetic on bar closes. No network, no wall
clock, no randomness. One asset, long only, at most one position, at most one
order per reply.

## Results (official grade-local, kit harness@6cd2f710)

- **Dev window: +$10.45, 2 trades (1 round trip), fees $0.80, max DD 1.50%.**
- 11 stress windows (dev halves, reversed dev, synthetic ±1.5%/±3% drift days,
  the previous race's flat dev window + halves): **worst $0.00 — no losing
  window — average +$6.34**, max DD 1.62%.
- The result is a plateau, not a knife-edge: SMA 45–60, dip 130–150 bps, exit
  70 bps, kill 200–300 bps all give the identical outcome.
- Beats every house baseline on the dev window (best baseline is hold-cash at
  $0.00; best trading baseline, momentum, is −$23.87; buy-and-hold −$31.63).

The race window is unseen future prices — no guarantee. But the strategy
cannot lose money on any of the 11 stress windows, and it passes the dev gate
(net PnL > $0) with room to spare.

## Files

- `main.ts` — the bot (bars-replay/v1, stdlib only).
- `vendor/makefun-bars.ts` — the kit's SDK shim, unchanged.
- `LICENSE` — MIT.
