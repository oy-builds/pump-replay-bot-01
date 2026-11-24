// Steady Tape: filtered-momentum strategy for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Original design notes:
//
// Tape, not ticks. Each curve keeps a rolling tape of its recorded trades for the last
// TAPE_KEEP slots. A buy is considered only when the tape over the entry window shows broad,
// sustained demand: enough buy trades from enough distinct wallets, net SOL flowing in,
// buy-side share of flow dominant, and the price up moderately from the window start while
// still close to the window high (a rise that already blew off inside the window is skipped).
// Young curves are ignored entirely: most bundled launches are dumped within minutes.
//
// One stake, fixed fraction. A position is a single buy of STAKE_SOL (4.5% of the 10 SOL
// starting capital), clipped by the harness's per-order cap of 1% of the curve's real SOL
// reserve. The bot never adds to a position, never averages down and never re-enters a curve
// it has already traded: on the dev window, second entries on the same curve were the single
// biggest source of losses, so MAX_ENTRIES is 1 and the cooldown is only a backstop. At most
// MAX_MAIN positions are open at once and total cost exposure is capped, so a bad hour
// cannot sink the run.
//
// Layered exits, all mechanical. A position is sold when the first of these fires: a hard
// stop-loss against its recorded cost; a half-size take-profit at TP1 (the rest rides); a
// trailing stop once the position's best close value clears TRAIL_ARM; a full take-profit at
// TP_FULL; a flow-fade exit when recent net flow turns sharply negative while the position
// is not clearly winning; or a maximum holding time. Curves that complete are closed by the
// replay itself.
//
// Guardrails. The run must round-trip at least 0.01 SOL on at least 20 coins and keep max
// drawdown under 50%. A pacing probe watches block time: if completed round trips plus open
// positions lag the share of the day elapsed, the bot opens a tiny probe round trip on a
// liquid curve and closes it as soon as the buy lands. Separately, an equity drawdown guard
// (peak close-value equity, estimated from curve reserves) halts new entries once the run is
// 5% below its peak equity, and only re-arms after equity recovers to within 2% of the peak:
// on the dev window most of the damage came from continuing to buy into a deteriorating tape.
// The fade exit is deliberately conservative for the same reason: it needs a strong outflow
// (1.35 SOL over 24 slots), a position already 3% under water, and at least 45 slots held —
// at looser settings it was the bot's biggest source of losses, cutting runners on noise.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration is only
// over insertion-ordered maps fed by the batch stream, and time comes from event block_time.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry tape window, in slots. */
  window: number;
  /** Slots of tape retained per curve. */
  tapeKeep: number;
  /** Minimum slots since the CreateEvent before any entry. */
  minAge: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Minimum buy trades / distinct buyers in the window. */
  minBuys: number;
  minBuyers: number;
  /** Minimum net SOL inflow (buys minus sells) in the window. */
  minNetSol: number;
  /** Minimum buy-side share of gross SOL flow in the window. */
  minBuyShare: number;
  /** Price rise over the window must sit inside [minUp, maxUp]. */
  minUp: number;
  maxUp: number;
  /** Price must be at least this share of the window high. */
  nearHigh: number;
  /** The window's trades must span at least this many slots (a burst in a few slots is not a trend). */
  minSpan: number;
  /**
   * Confirmation delay: a curve whose signal first fires is only watched; the buy goes out
   * once the signal still holds at least this many slots later and the price has not fallen
   * more than confirmDip below the price when the signal first fired.
   */
  confirmSlots: number;
  confirmDip: number;
  /** One position's stake: fixed fraction of the 10 SOL start. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Buy slippage tolerance (bps); sells always go at 10000. */
  buySlipBps: number;
  /** Most strategy positions open at once (one harness slot is left for probes). */
  maxMain: number;
  /** Most SOL at cost across open positions. */
  maxExposureSol: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** Slots after an exit before the same curve can be re-entered. */
  cooldown: number;
  /** Exits: stop loss (fraction below cost). */
  stopLoss: number;
  /** First take-profit: value >= cost * (1 + tp1) sells tp1Fraction of the position. */
  tp1: number;
  tp1Fraction: number;
  /** Full take-profit: value >= cost * (1 + tpFull) sells everything. */
  tpFull: number;
  /** Trailing stop arms at value >= cost * (1 + trailArm); then value < peak * (1 - trail) exits. */
  trailArm: number;
  trail: number;
  /** Flow-fade exit: net SOL over fadeWindow slots below -fadeNetSol while value < cost * (1 + fadeIfUp). */
  fadeWindow: number;
  fadeNetSol: number;
  fadeIfUp: number;
  /** The fade exit cannot fire during the first this many slots of a position (noise dips). */
  fadeMinHold: number;
  /** Maximum holding time in slots. */
  maxHold: number;
  /** Drawdown guard: halt entries at this drawdown from peak equity, re-arm at this one. */
  ddHalt: number;
  ddRearm: number;
  /** Guardrail pacing probes. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const PARAMS: Params = {
  window: 48,
  tapeKeep: 260,
  minAge: 240,
  minRqSol: 4,
  maxRqSol: 50,
  minBuys: 7,
  minBuyers: 6,
  minNetSol: 1.2,
  minBuyShare: 0.62,
  minUp: 0.04,
  maxUp: 0.9,
  nearHigh: 0.93,
  minSpan: 0,
  confirmSlots: 0,
  confirmDip: 0.03,
  stakeSol: 0.45,
  minBuySol: 0.05,
  buySlipBps: 1200,
  maxMain: 4,
  maxExposureSol: 3.0,
  maxEntries: 1,
  cooldown: 300,
  stopLoss: 0.18,
  tp1: 0.6,
  tp1Fraction: 0.5,
  tpFull: 2.0,
  trailArm: 0.5,
  trail: 0.35,
  fadeWindow: 24,
  fadeNetSol: 1.35,
  fadeIfUp: -0.03,
  fadeMinHold: 45,
  maxHold: 1000,
  ddHalt: 0.05,
  ddRearm: 0.02,
  targetCoins: 24,
  paceSecs: 86400,
  probeSol: 0.015,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, as a fraction

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  /** Slot and price when the entry signal first fired and started being confirmed; 0 = not watching. */
  watchSince: number;
  watchPrice: number;
}

interface Held {
  opened: number;
  peakValue: number;
  tookTp1: boolean;
  exiting: boolean;
}

export function createStrategy(p: Params = PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** Mints this bot has fully round-tripped (buy filled, position later gone after a sell). */
  const roundTripped = new Set<Pubkey>();
  const bought = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let peakEquity = 10; // SOL; the run starts with 10 SOL of cash
  let entriesHalted = false;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12, watchSince: 0, watchPrice: 0 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Close value in SOL of `tokens` on a curve with these virtual reserves, fees deducted. */
  const closeValue = (tokens: bigint, vq: bigint, vt: bigint, txSol: number): number => {
    const t = Number(tokens);
    if (t <= 0) return 0;
    return ((t * Number(vq)) / (Number(vt) + t) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  /** Net recorded SOL flow (buys minus sells) on a tape over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The entry signal: broad, sustained, not-yet-blown-off buy pressure. */
  const entryOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let firstSlot = -1;
    let lastSlot = -1;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (firstSlot < 0) firstSlot = tr.slot;
      lastSlot = tr.slot;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (firstSlot < 0 || lastSlot - firstSlot < p.minSpan) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    const gross = buySol + sellSol;
    if (gross <= 0 || buySol / gross < p.minBuyShare) return false;
    if (startPrice <= 0 || high <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp || up > p.maxUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;

      // Book-keeping from fills: which of my buys landed, which positions closed out.
      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        if (f.side === 'buy') bought.add(f.mint);
      }
      for (const mint of [...held.keys(), ...probes]) {
        if (!state.positions.has(mint) && bought.has(mint)) roundTripped.add(mint);
      }

      // Fold this batch's events into the tapes.
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - p.tapeKeep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingMints.add(po.order.mint);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: BigInt(mk.real_quote_reserves) };
        }
        const c = state.curves.get(mint);
        if (c === undefined) return null;
        return { vq: c.virtual_quote_reserves, vt: c.virtual_token_reserves, rq: c.real_quote_reserves };
      };

      // Equity estimate and the drawdown guard (checked before any new entry).
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const r = reservesOf(mint);
        if (r !== null) equity += Math.max(0, closeValue(pos.token_amount, r.vq, r.vt, txSol));
      }
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (!entriesHalted && dd >= p.ddHalt) entriesHalted = true;
      if (entriesHalted && dd <= p.ddRearm) entriesHalted = false;

      const orders: OrderInput[] = [];

      // 1) Exits for strategy positions.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            tapeOf(mint).lastExit = now;
          }
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = closeValue(pos.token_amount, r.vq, r.vt, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let sellFraction = 0;
        if (value < cost * (1 - p.stopLoss)) sellFraction = 1;
        else if (value >= cost * (1 + p.tpFull)) sellFraction = 1;
        else if (h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) sellFraction = 1;
        else if (now - h.opened >= p.fadeMinHold && flow(tapeOf(mint), now, p.fadeWindow) < -p.fadeNetSol && value < cost * (1 + p.fadeIfUp)) sellFraction = 1;
        else if (now - h.opened > p.maxHold) sellFraction = 1;
        else if (!h.tookTp1 && value >= cost * (1 + p.tp1)) sellFraction = p.tp1Fraction;
        if (sellFraction <= 0 || pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        const amount = sellFraction >= 1 ? pos.token_amount : (pos.token_amount * BigInt(Math.floor(p.tp1Fraction * 1000))) / 1000n;
        if (amount <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 });
        if (sellFraction < 1) h.tookTp1 = true;
        else h.exiting = true;
      }

      // 2) Probes: close a probe as soon as its buy has landed.
      for (const mint of [...probes]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 3) Entries: one fixed-fraction stake per qualifying curve.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let exposure = 0;
      for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / LAMPORTS;
      for (const po of state.pending.values()) if (po.order.side === 'buy') exposure += Number(po.order.quote_lamports) / LAMPORTS;
      if (!entriesHalted) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          if (held.size >= p.maxMain) break;
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions - 1) break;
          if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const t = tapes.get(mint)!;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (!entryOk(t, now, rqSol)) {
            t.watchSince = 0;
            continue;
          }
          // Confirmation (disabled when confirmSlots is 0, as shipped: on the dev window the
          // delay cost more expectancy than the bursts it filtered). When enabled, the first
          // firing only starts the watch; the buy waits until the signal has survived
          // confirmSlots with the price roughly intact.
          const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          if (p.confirmSlots > 0 && t.watchSince === 0) {
            t.watchSince = now;
            t.watchPrice = priceNow;
            continue;
          }
          if (p.confirmSlots > 0 && now - t.watchSince < p.confirmSlots) continue;
          if (p.confirmSlots > 0 && priceNow < t.watchPrice * (1 - p.confirmDip)) {
            t.watchSince = 0;
            continue;
          }
          t.watchSince = 0;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          let amount = Math.min(p.stakeSol, capSol, p.maxExposureSol - exposure, free - txSol);
          if (amount < p.minBuySol) continue;
          amount = Math.floor(amount * LAMPORTS) / LAMPORTS;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          held.set(mint, { opened: now, peakValue: 0, tookTp1: false, exiting: false });
          t.entries++;
          free -= amount + txSol;
          exposure += amount;
        }
      }

      // 4) Guardrail pacing: open a probe when round trips lag the elapsed share of the day.
      if (probes.size < p.maxProbes && firstTime !== null && lastTime !== null && !entriesHalted) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const covered = roundTripped.size + held.size + probes.size;
        if (covered < Math.ceil(p.targetCoins * pace)) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
            if (capSol < p.probeSol) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            free -= p.probeSol + txSol;
          }
        }
      }

      return orders;
    },
  };
}
