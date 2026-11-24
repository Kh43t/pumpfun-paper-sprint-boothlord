// TwinGate — a two-look age-judged pump.fun paper trader.
//
// Idea in one paragraph: most pump.fun coins die within minutes, but the few
// that keep attracting real buyers for a while sometimes run hard. TwinGate
// never chases a coin at birth. It watches every new curve and judges it
// twice — once at 35 slots old and once more at 60 slots for slow starters —
// and only opens a small probe when the coin still looks alive at a check:
// real SOL reserves of at least 13, at least 14 different buyers so far,
// at least 3 SOL of net buying in the last 25 slots, and a price between
// 1.5x and 9x its creation price. Winners are fed with small adds only on
// fresh highs while reserves keep growing, and every position is defended by
// staged profit banks, a hard stop, a trailing give-back exit, a
// reserve-collapse exit, and a staleness / maximum-hold clock.
//
// Everything here is deterministic: no clock, no environment, no randomness.
// All arithmetic is integer (bigint) so the two grading runs agree exactly.
// Prices are virtual-quote-per-virtual-token, scaled by 1_000_000.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = LAMPORTS_PER_SOL;
const SCALE = 1_000_000n; // price scale: quote lamports per token, scaled

const PROBE_LAMPORTS = (SOL * 2n) / 100n; // 0.02 SOL first buy
const ADD_LAMPORTS = (SOL * 12n) / 100n; // 0.12 SOL per add on a new high
const MAX_STAKE_LAMPORTS = (SOL * 60n) / 100n; // 0.60 SOL total per coin
const MAX_ADD_MULT_X1000 = 6000n; // never add above 6x the create price

const JUDGE_AGE_1 = 35; // slots after creation: first look
const JUDGE_AGE_2 = 60; // slots after creation: second look
const MIN_RESERVES_SOL = 13n; // real SOL reserves at a check
const MIN_BUYERS = 14; // distinct buyers seen by a check
const MIN_FLOW_LAMPORTS = SOL * 3n; // net buys minus sells, last 25 slots
const FLOW_WINDOW_SLOTS = 25;
const MIN_MULT_X1000 = 1500n; // 1.5x create price
const MAX_MULT_X1000 = 9000n; // 9x create price

const BANK_1_MULT_X1000 = 2000n; // bank 60% of tokens at 2x value
const BANK_1_FRAC_NUM = 60n;
const BANK_2_MULT_X1000 = 3500n; // bank 50% of the rest at 3.5x
const BANK_2_FRAC_NUM = 50n;

const STOP_X1000 = 820n; // hard stop: value under 82% of cost (-18%)
const TRAIL_ARM_X1000 = 1350n; // trailing arms once value is +35%
const TRAIL_KEEP_X1000 = 750n; // exit once value falls to 75% of its peak
const RESERVE_COLLAPSE_NUM = 45n; // exit if reserves fall under 45% of peak
const STALE_SLOTS = 500; // exit if no fresh high for this long
const MAX_HOLD_SLOTS = 900; // exit no matter what after this long

const SLIPPAGE_BPS = 1000; // 10%: wide enough to survive 2-slot latency
const MAX_TRADES_KEPT = 400; // trades remembered per coin (flow window only)
const MAX_BUYERS_KEPT = 200; // distinct buyers remembered per coin

// ------------------------------------------------------------------ per-coin bookkeeping

interface Coin {
  mint: string;
  createdSlot: number;
  createPrice: bigint; // scaled price at creation (0n when unknown)
  buyers: Set<string>;
  // Recent trades: slot, buy?, SOL moved. Pruned to the flow window.
  trades: { slot: number; buy: boolean; sol: bigint }[];
  judged1: boolean;
  judged2: boolean;
  decided: boolean; // judged and rejected, or entered — never judge again
  // Position bookkeeping, live only while a position is held.
  peakPrice: bigint;
  peakReserves: bigint;
  peakValue: bigint;
  lastHighSlot: number;
  entrySlot: number;
  invested: bigint; // lamports spent on buys that filled
  buys: number;
  banked1: boolean;
  banked2: boolean;
  trailingArmed: boolean;
}

function newCoin(mint: string, slot: number, createPrice: bigint): Coin {
  return {
    mint,
    createdSlot: slot,
    createPrice,
    buyers: new Set(),
    trades: [],
    judged1: false,
    judged2: false,
    decided: false,
    peakPrice: 0n,
    peakReserves: 0n,
    peakValue: 0n,
    lastHighSlot: slot,
    entrySlot: 0,
    invested: 0n,
    buys: 0,
    banked1: false,
    banked2: false,
    trailingArmed: false,
  };
}

/** Scaled price of a curve: virtual quote reserves per virtual token. */
function priceOf(vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (vQuote * SCALE) / vToken;
}

/** Value in lamports of `tokens` at the curve's current scaled price. */
function valueOf(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

// ------------------------------------------------------------------ the bot

export function createTwinGate() {
  const coins = new Map<string, Coin>();
  const pending: Coin[] = []; // coins created, not yet decided
  const buyClient = new Map<string, string>(); // client_id -> mint, for fills
  let clientSeq = 1;

  function nextClientId(): string {
    return `tg${clientSeq++}`;
  }

  function dropCoin(mint: string): void {
    coins.delete(mint);
    const i = pending.findIndex((c) => c.mint === mint);
    if (i >= 0) pending.splice(i, 1);
  }

  /** Net SOL flow (buys minus sells) over the last FLOW_WINDOW_SLOTS slots. */
  function netFlow(c: Coin, now: number): bigint {
    const from = now - FLOW_WINDOW_SLOTS;
    let flow = 0n;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const t = c.trades[i];
      if (t.slot < from) break;
      flow += t.buy ? t.sol : -t.sol;
    }
    return flow;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const now = state.slot;
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // --- 1. Fold this batch's fills into the per-coin books. -------------
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      const mint = buyClient.get(f.client_id);
      if (mint === undefined) continue; // a sell, or a harness close
      buyClient.delete(f.client_id);
      if (f.side !== 'buy') continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      c.invested += BigInt(f.quote_lamports);
      c.buys += 1;
    }

    // --- 2. Ingest this batch's events. ----------------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const createPrice = priceOf(
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
        );
        const c = newCoin(e.mint, e.slot, createPrice);
        coins.set(e.mint, c);
        pending.push(c);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined || c.decided) continue;
        if (e.is_buy) {
          if (c.buyers.size < MAX_BUYERS_KEPT) c.buyers.add(e.user);
        }
        c.trades.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount) });
        if (c.trades.length > MAX_TRADES_KEPT) {
          c.trades.splice(0, c.trades.length - MAX_TRADES_KEPT);
        }
      } else if (e.event === 'CompleteEvent') {
        // The curve migrated: the harness closes any position itself.
        // A coin with no position is simply gone.
        if (!state.positions.has(e.mint)) dropCoin(e.mint);
      }
    }

    // --- 3. Manage open positions: exits first, then adds. --------------
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const c = coins.get(mint);
      if (curve === undefined || c === undefined) continue;
      if (curve.complete) continue; // harness closes it

      const tokens = pos.token_amount;
      const cost = pos.cost_lamports;
      if (tokens <= 0n || cost <= 0n) continue;
      const value = valueOf(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const multX1000 = (value * 1000n) / cost;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const reserves = curve.real_quote_reserves;

      // A fresh high means the price beat every price seen since entry.
      // Capture it BEFORE folding this batch into the peaks.
      const isNewHigh = price > c.peakPrice;
      if (isNewHigh) {
        c.peakPrice = price;
        c.lastHighSlot = now;
      }
      if (reserves > c.peakReserves) c.peakReserves = reserves;
      if (value > c.peakValue) c.peakValue = value;
      if (multX1000 >= TRAIL_ARM_X1000) c.trailingArmed = true;

      // Full-exit checks, worst first.
      let exitAll = false;
      if (value * 1000n < cost * STOP_X1000) exitAll = true; // hard stop
      else if (c.trailingArmed && value * 1000n < c.peakValue * TRAIL_KEEP_X1000) exitAll = true;
      else if (c.peakReserves > 0n && reserves * 100n < c.peakReserves * RESERVE_COLLAPSE_NUM) exitAll = true;
      else if (now - c.lastHighSlot > STALE_SLOTS) exitAll = true;
      else if (now - c.entrySlot > MAX_HOLD_SLOTS) exitAll = true;

      if (exitAll) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: tokens,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        continue;
      }

      // Staged profit banks, one per batch at most.
      if (!c.banked1 && multX1000 >= BANK_1_MULT_X1000) {
        const sell = (tokens * BANK_1_FRAC_NUM) / 100n;
        if (sell > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
          c.banked1 = true;
          continue;
        }
      }
      if (c.banked1 && !c.banked2 && multX1000 >= BANK_2_MULT_X1000) {
        const sell = (tokens * BANK_2_FRAC_NUM) / 100n;
        if (sell > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
          c.banked2 = true;
          continue;
        }
      }

      // Add on a fresh high while reserves are still growing, under the cap.
      if (
        c.buys > 0 &&
        isNewHigh &&
        c.invested + ADD_LAMPORTS <= MAX_STAKE_LAMPORTS &&
        multX1000 < MAX_ADD_MULT_X1000 &&
        reserves >= c.peakReserves &&
        orders.length < caps.max_orders_per_batch
      ) {
        const cap = state.maxBuyLamports(mint);
        let amount = ADD_LAMPORTS;
        if (amount > cap) amount = cap;
        const room = MAX_STAKE_LAMPORTS - c.invested;
        if (amount > room) amount = room;
        if (amount >= PROBE_LAMPORTS && free >= amount + txFee) {
          const id = nextClientId();
          buyClient.set(id, mint);
          orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
          free -= amount + txFee;
        }
      }
    }

    // --- 4. Judge undecided coins at age 35, then again at 60. ----------
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      const age = now - c.createdSlot;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) {
        pending.splice(i, 1);
        continue;
      }
      if (age < JUDGE_AGE_1) continue;
      const due1 = !c.judged1 && age >= JUDGE_AGE_1;
      const due2 = !c.judged2 && age >= JUDGE_AGE_2;
      if (!due1 && !due2) continue;
      if (due1) c.judged1 = true;
      if (due2) c.judged2 = true;

      const reserves = curve.real_quote_reserves;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const multX1000 = c.createPrice > 0n ? (price * 1000n) / c.createPrice : 0n;
      const flow = netFlow(c, now);
      const alive =
        reserves >= MIN_RESERVES_SOL * SOL &&
        c.buyers.size >= MIN_BUYERS &&
        flow >= MIN_FLOW_LAMPORTS &&
        multX1000 >= MIN_MULT_X1000 &&
        multX1000 <= MAX_MULT_X1000;

      if (!alive) {
        if (c.judged2) {
          // Both looks used up and still not alive: forget it.
          c.decided = true;
          pending.splice(i, 1);
          if (age > JUDGE_AGE_2 + 60) dropCoin(c.mint);
        }
        continue;
      }

      // Alive at a check: open the probe, if room and cash allow.
      if (
        openSlots > 0 &&
        orders.length < caps.max_orders_per_batch &&
        free >= PROBE_LAMPORTS + txFee
      ) {
        const cap = state.maxBuyLamports(c.mint);
        let amount = PROBE_LAMPORTS;
        if (amount > cap) amount = cap;
        if (amount >= PROBE_LAMPORTS / 2n) {
          const id = nextClientId();
          buyClient.set(id, c.mint);
          orders.push({ side: 'buy', client_id: id, mint: c.mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
          free -= amount + txFee;
          openSlots -= 1;
          c.decided = true;
          c.entered = true;
          c.entrySlot = now;
          c.peakPrice = price;
          c.peakReserves = reserves;
          c.lastHighSlot = now;
          pending.splice(i, 1);
        }
      } else if (c.judged2) {
        // No room now and no more looks left: let it go.
        c.decided = true;
        pending.splice(i, 1);
      }
    }

    // --- 5. Housekeeping: forget old decided coins with no position. -----
    if (coins.size > 4000) {
      for (const [mint, c] of coins) {
        if (!state.positions.has(mint) && c.decided && now - c.createdSlot > MAX_HOLD_SLOTS) {
          dropCoin(mint);
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
