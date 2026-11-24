// TwinGate — a two-look age-judged pump.fun paper trader.
//
// Idea in one paragraph: most pump.fun coins die within minutes, but the few
// that keep attracting real buyers for a while sometimes run hard. TwinGate
// never chases a coin at birth. It watches every new curve and judges it
// twice — once at 35 slots old and once more at 60 slots for slow starters —
// and only opens a small probe when the coin still looks alive at a check:
// real SOL reserves of at least 14, at least 14 different buyers so far,
// at least 3 SOL of net buying in the last 25 slots, and a price between
// 1.5x and 9x its creation price. Winners are fed with small adds only on
// fresh highs while reserves keep growing, and every position is defended by
// staged profit banks, a hard stop, a trailing give-back exit, a
// reserve-collapse exit, and a staleness / maximum-hold clock.
//
// A second, scout tier buys breadth: the strict tier alone trades too few
// coins to clear the 20-coin guardrail in a slow 6-hour window, so coins
// that fail both main looks get a tiny 0.015 SOL probe at a loose bar, with
// fast exits and no adds. A scout costs little when it loses and counts
// toward the guardrail when it trades.
//
// Everything here is deterministic: no clock, no environment, no randomness.
// All arithmetic is integer (bigint) so the two grading runs agree exactly.
// Prices are virtual-quote-per-virtual-token, scaled by 1_000_000.
//
// The tunables live in DEFAULT_PARAMS below; createTwinGate() takes overrides
// so offline sweeps can move them without touching the logic.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const SCALE = 1_000_000n; // price scale: quote lamports per token, scaled

export interface TwinGateParams {
  probeSol: number; // first buy, SOL
  addSol: number; // each add on a fresh high, SOL
  maxStakeSol: number; // total per coin, SOL
  maxAddMult: number; // never add above this multiple of create price
  judgeAge1: number; // slots after creation: first look
  judgeAge2: number; // slots after creation: second look
  minReservesSol: number; // real SOL reserves at a check
  minBuyers: number; // distinct buyers seen by a check
  minFlowSol: number; // net buys minus sells over the flow window, SOL
  flowWindowSlots: number;
  minMult: number; // lowest entry multiple of create price
  maxMult: number; // highest entry multiple of create price
  // Second-look bars: a coin still alive at judgeAge2 has survived longer,
  // so it may enter on slightly softer numbers than a first-look coin.
  minReservesSol2: number;
  minBuyers2: number;
  minFlowSol2: number;
  minMult2: number;
  maxMult2: number;
  // Scout tier: cheap breadth insurance. The strict main tier trades too few
  // coins to clear the 20-coin guardrail in a slow 6h window (10-18 per
  // block in dev), so coins that fail both main looks get a tiny probe at a
  // loose bar, with fast exits and no adds. A scout costs little when it
  // loses and counts toward the guardrail when it trades.
  scoutProbeSol: number; // 0.015 SOL: above the 0.01 SOL round-trip bar
  scoutMinReservesSol: number;
  scoutMinBuyers: number;
  scoutMinFlowSol: number;
  scoutMinMult: number;
  scoutMaxMult: number;
  scoutJudgeAge2: number; // slots: second scout look
  scoutStopMult: number;
  scoutTrailArmMult: number;
  scoutTrailKeep: number;
  scoutBankMult: number;
  scoutBankFrac: number;
  scoutStaleSlots: number;
  scoutMaxHoldSlots: number;
  scoutReserveCollapse: number;
  bank1Mult: number; // bank bank1Frac of tokens at this value multiple
  bank1Frac: number; // percent of tokens banked at bank1Mult
  bank2Mult: number; // bank bank2Frac of the rest at this value multiple
  bank2Frac: number; // percent of remaining tokens banked at bank2Mult
  stopMult: number; // hard stop: value under this multiple of cost
  trailArmMult: number; // trailing arms once value reaches this multiple
  trailKeep: number; // exit once value falls to this share of its peak
  reserveCollapse: number; // exit if reserves fall under this share of peak
  staleSlots: number; // exit if no fresh high for this long
  maxHoldSlots: number; // exit no matter what after this long
  slippageBps: number;
}

export const DEFAULT_PARAMS: TwinGateParams = {
  probeSol: 0.03,
  addSol: 0.12,
  maxStakeSol: 0.6,
  maxAddMult: 6,
  judgeAge1: 35,
  judgeAge2: 60,
  minReservesSol: 14,
  minBuyers: 14,
  minFlowSol: 3,
  flowWindowSlots: 25,
  minMult: 1.5,
  maxMult: 9,
  minReservesSol2: 14,
  minBuyers2: 14,
  minFlowSol2: 3,
  minMult2: 1.5,
  maxMult2: 9,
  scoutProbeSol: 0.015,
  scoutMinReservesSol: 6,
  scoutMinBuyers: 6,
  scoutMinFlowSol: 1,
  scoutMinMult: 1.1,
  scoutMaxMult: 15,
  scoutJudgeAge2: 120,
  scoutStopMult: 0.9,
  scoutTrailArmMult: 1.25,
  scoutTrailKeep: 0.8,
  scoutBankMult: 1.5,
  scoutBankFrac: 50,
  scoutStaleSlots: 150,
  scoutMaxHoldSlots: 300,
  scoutReserveCollapse: 0.5,
  bank1Mult: 2,
  bank1Frac: 60,
  bank2Mult: 3.5,
  bank2Frac: 50,
  stopMult: 0.82,
  trailArmMult: 1.35,
  trailKeep: 0.8,
  reserveCollapse: 0.45,
  staleSlots: 300,
  maxHoldSlots: 600,
  slippageBps: 2000,
};

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
  scout: boolean; // scout-tier position: tiny probe, fast exits, no adds
  scout1: boolean; // scout look at judgeAge2 done
  scout2: boolean; // scout look at scoutJudgeAge2 done
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
    scout: false,
    scout1: false,
    scout2: false,
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

const toLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));
const toX1000 = (x: number): bigint => BigInt(Math.round(x * 1000));

// ------------------------------------------------------------------ the bot

export function createTwinGate(overrides: Partial<TwinGateParams> = {}) {
  const p: TwinGateParams = { ...DEFAULT_PARAMS, ...overrides };

  const PROBE = toLamports(p.probeSol);
  const ADD = toLamports(p.addSol);
  const MAX_STAKE = toLamports(p.maxStakeSol);
  const MAX_ADD_MULT_X1000 = toX1000(p.maxAddMult);
  const MIN_RESERVES = toLamports(p.minReservesSol);
  const MIN_FLOW = toLamports(p.minFlowSol);
  const MIN_MULT_X1000 = toX1000(p.minMult);
  const MAX_MULT_X1000 = toX1000(p.maxMult);
  const MIN_RESERVES_2 = toLamports(p.minReservesSol2);
  const MIN_FLOW_2 = toLamports(p.minFlowSol2);
  const MIN_MULT_X1000_2 = toX1000(p.minMult2);
  const MAX_MULT_X1000_2 = toX1000(p.maxMult2);
  const BANK_1_MULT_X1000 = toX1000(p.bank1Mult);
  const BANK_1_FRAC = BigInt(p.bank1Frac);
  const BANK_2_MULT_X1000 = toX1000(p.bank2Mult);
  const BANK_2_FRAC = BigInt(p.bank2Frac);
  const STOP_X1000 = toX1000(p.stopMult);
  const TRAIL_ARM_X1000 = toX1000(p.trailArmMult);
  const TRAIL_KEEP_X1000 = toX1000(p.trailKeep);
  const RESERVE_COLLAPSE_NUM = BigInt(Math.round(p.reserveCollapse * 100));
  const SLIPPAGE_BPS = p.slippageBps;
  const SCOUT_PROBE = toLamports(p.scoutProbeSol);
  const SCOUT_MIN_RESERVES = toLamports(p.scoutMinReservesSol);
  const SCOUT_MIN_FLOW = toLamports(p.scoutMinFlowSol);
  const SCOUT_MIN_MULT_X1000 = toX1000(p.scoutMinMult);
  const SCOUT_MAX_MULT_X1000 = toX1000(p.scoutMaxMult);
  const SCOUT_STOP_X1000 = toX1000(p.scoutStopMult);
  const SCOUT_TRAIL_ARM_X1000 = toX1000(p.scoutTrailArmMult);
  const SCOUT_TRAIL_KEEP_X1000 = toX1000(p.scoutTrailKeep);
  const SCOUT_BANK_MULT_X1000 = toX1000(p.scoutBankMult);
  const SCOUT_BANK_FRAC = BigInt(p.scoutBankFrac);
  const SCOUT_RESERVE_COLLAPSE_NUM = BigInt(Math.round(p.scoutReserveCollapse * 100));
  const MAX_TRADES_KEPT = 400; // trades remembered per coin (flow window only)
  const MAX_BUYERS_KEPT = 200; // distinct buyers remembered per coin

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

  /** Net SOL flow (buys minus sells) over the last p.flowWindowSlots slots. */
  function netFlow(c: Coin, now: number): bigint {
    const from = now - p.flowWindowSlots;
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
    // Orders already in flight still show in state.positions until their
    // fills land 2 slots later, so size new sells against the tokens that
    // are not already promised away, and count pending buys toward the
    // per-coin stake cap.
    const pendingSell = new Map<string, bigint>();
    const pendingBuy = new Map<string, bigint>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') {
        pendingSell.set(p.order.mint, (pendingSell.get(p.order.mint) ?? 0n) + BigInt(p.order.token_amount));
      } else {
        pendingBuy.set(p.order.mint, (pendingBuy.get(p.order.mint) ?? 0n) + BigInt(p.order.quote_lamports));
      }
    }

    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const c = coins.get(mint);
      if (curve === undefined || c === undefined) continue;
      if (curve.complete) continue; // harness closes it

      const tokens = pos.token_amount;
      const freeTokens = tokens - (pendingSell.get(mint) ?? 0n);
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
      // Scouts run on tighter rails than main positions.
      const stopX = c.scout ? SCOUT_STOP_X1000 : STOP_X1000;
      const armX = c.scout ? SCOUT_TRAIL_ARM_X1000 : TRAIL_ARM_X1000;
      const keepX = c.scout ? SCOUT_TRAIL_KEEP_X1000 : TRAIL_KEEP_X1000;
      const collapseNum = c.scout ? SCOUT_RESERVE_COLLAPSE_NUM : RESERVE_COLLAPSE_NUM;
      const stale = c.scout ? p.scoutStaleSlots : p.staleSlots;
      const maxHold = c.scout ? p.scoutMaxHoldSlots : p.maxHoldSlots;
      if (multX1000 >= armX) c.trailingArmed = true;

      // Full-exit checks, worst first.
      let exitAll = false;
      if (value * 1000n < cost * stopX) exitAll = true; // hard stop
      else if (c.trailingArmed && value * 1000n < c.peakValue * keepX) exitAll = true;
      else if (c.peakReserves > 0n && reserves * 100n < c.peakReserves * collapseNum) exitAll = true;
      else if (now - c.lastHighSlot > stale) exitAll = true;
      else if (now - c.entrySlot > maxHold) exitAll = true;

      if (exitAll) {
        if (freeTokens > 0n) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: freeTokens,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
        continue;
      }

      // Staged profit banks, one per batch at most. Scouts bank once, early.
      const bank1MultX = c.scout ? SCOUT_BANK_MULT_X1000 : BANK_1_MULT_X1000;
      const bank1FracX = c.scout ? SCOUT_BANK_FRAC : BANK_1_FRAC;
      if (!c.banked1 && multX1000 >= bank1MultX) {
        const sell = (freeTokens * bank1FracX) / 100n;
        if (sell > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
          c.banked1 = true;
          continue;
        }
      }
      if (!c.scout && c.banked1 && !c.banked2 && multX1000 >= BANK_2_MULT_X1000) {
        const sell = (freeTokens * BANK_2_FRAC) / 100n;
        if (sell > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
          c.banked2 = true;
          continue;
        }
      }

      // Adds are main-tier only, on a fresh high while reserves grow.
      const investedNow = c.invested + (pendingBuy.get(mint) ?? 0n);
      if (
        !c.scout &&
        c.buys > 0 &&
        isNewHigh &&
        investedNow + ADD <= MAX_STAKE &&
        multX1000 < MAX_ADD_MULT_X1000 &&
        reserves >= c.peakReserves &&
        orders.length < caps.max_orders_per_batch
      ) {
        const cap = state.maxBuyLamports(mint);
        let amount = ADD;
        if (amount > cap) amount = cap;
        const room = MAX_STAKE - investedNow;
        if (amount > room) amount = room;
        if (amount >= PROBE && free >= amount + txFee) {
          const id = nextClientId();
          buyClient.set(id, mint);
          orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
          free -= amount + txFee;
        }
      }
    }

    // --- 4. Judge undecided coins, in stages. ---------------------------
    // Main looks at judgeAge1 and judgeAge2 on the strict bar; a coin that
    // fails both then gets two scout looks (judgeAge2 and scoutJudgeAge2)
    // on the loose bar, for a tiny probe. Scouts only take a slot when at
    // least two are free, so a main entry is never crowded out.
    const enter = (c: Coin, price: bigint, reserves: bigint, scout: boolean): boolean => {
      const probe = scout ? SCOUT_PROBE : PROBE;
      const needSlots = scout ? 2 : 1;
      if (openSlots < needSlots) return false;
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (free < probe + txFee) return false;
      const cap = state.maxBuyLamports(c.mint);
      let amount = probe;
      if (amount > cap) amount = cap;
      if (amount < probe / 2n) return false;
      const id = nextClientId();
      buyClient.set(id, c.mint);
      orders.push({ side: 'buy', client_id: id, mint: c.mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      free -= amount + txFee;
      openSlots -= 1;
      c.decided = true;
      c.scout = scout;
      c.entrySlot = now;
      c.peakPrice = price;
      c.peakReserves = reserves;
      c.lastHighSlot = now;
      return true;
    };

    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      const age = now - c.createdSlot;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) {
        pending.splice(i, 1);
        continue;
      }
      if (age < p.judgeAge1) continue;

      const reserves = curve.real_quote_reserves;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const multX1000 = c.createPrice > 0n ? (price * 1000n) / c.createPrice : 0n;
      const flow = netFlow(c, now);
      const mainAlive = (second: boolean): boolean =>
        reserves >= (second ? MIN_RESERVES_2 : MIN_RESERVES) &&
        c.buyers.size >= (second ? p.minBuyers2 : p.minBuyers) &&
        flow >= (second ? MIN_FLOW_2 : MIN_FLOW) &&
        multX1000 >= (second ? MIN_MULT_X1000_2 : MIN_MULT_X1000) &&
        multX1000 <= (second ? MAX_MULT_X1000_2 : MAX_MULT_X1000);
      const scoutAlive = (): boolean =>
        reserves >= SCOUT_MIN_RESERVES &&
        c.buyers.size >= p.scoutMinBuyers &&
        flow >= SCOUT_MIN_FLOW &&
        multX1000 >= SCOUT_MIN_MULT_X1000 &&
        multX1000 <= SCOUT_MAX_MULT_X1000;

      // Main look 1.
      if (!c.judged1 && age >= p.judgeAge1) {
        c.judged1 = true;
        if (mainAlive(false) && enter(c, price, reserves, false)) {
          pending.splice(i, 1);
          continue;
        }
      }
      // Main look 2, then scout look 1 at the same age.
      if (!c.judged2 && age >= p.judgeAge2) {
        c.judged2 = true;
        if (mainAlive(true) && enter(c, price, reserves, false)) {
          pending.splice(i, 1);
          continue;
        }
        c.scout1 = true;
        if (scoutAlive() && enter(c, price, reserves, true)) {
          pending.splice(i, 1);
          continue;
        }
      }
      // Scout look 2, for late survivors.
      if (c.judged2 && c.scout1 && !c.scout2 && age >= p.scoutJudgeAge2) {
        c.scout2 = true;
        if (scoutAlive() && enter(c, price, reserves, true)) {
          pending.splice(i, 1);
          continue;
        }
      }
      // Every look used up and still not in: forget it.
      if (c.judged2 && c.scout1 && c.scout2) {
        c.decided = true;
        pending.splice(i, 1);
        if (age > p.scoutJudgeAge2 + 60) dropCoin(c.mint);
      }
    }

    // --- 5. Housekeeping: forget old decided coins with no position. -----
    if (coins.size > 4000) {
      for (const [mint, c] of coins) {
        if (!state.positions.has(mint) && c.decided && now - c.createdSlot > p.maxHoldSlots) {
          dropCoin(mint);
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
