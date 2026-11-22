// ELPIDA V2.3 trader rewards: the Elpida Weighted Participation Reward (EWPR). Approved by Malik on 22 November 2026 for
// the monthly trader airdrop on every chain, paid in USDC. It replaces the 20% equal / 40% square root / 40% pro-rata
// blend of v2-airdrop.mjs for every round from EWPR_FROM_ROUND on (earlier rounds keep the rules they were posted with).
//
//   Eligibility, per trader (a group of linked wallets) and calendar month (UTC):
//     at least $100 of qualified volume, 8 qualified trades, 4 qualified days, qualified days in 2 different UTC weeks
//     (Monday to Sunday), and $1 of fees. Creator-linked groups never qualify.
//     A qualified trade is a fee-paying trade worth at least $1; a qualified day is a UTC day on which the group paid at
//     least $0.10 in fees. Buys and sells count the same.
//   Score:   S = F^0.8 × C,  C = 0.8 + 0.2 × min(D, 12) / 12
//     F: the group's fees in dollars, D: its qualified days.
//   Reward:  R = V × S / ΣS, rounded down; the rounding dust stays in the vault for the next month.
//
// Exact and reproducible: F is in micro-dollars, F^0.8 is the integer fifth root of F^4 (rounded down), and C is
// scaled by 12,000, so S is an integer anyone can recompute from the published trades. No cap: the 0.8 exponent already
// gives diminishing returns, and wallet linking stops splitting one trader into many (v2-keeper-plan.mjs linkGroups).
import { linkWallets } from './v2-airdrop.mjs';

export const EWPR_RULES = Object.freeze({
  version: 'ewpr-1',
  minVolumeUsd: 100,
  minTrades: 8,
  minDays: 4,
  minWeeks: 2,
  minFeesUsd: 1,
  /** A trade counts towards the 8 only from this value (dust trades do not). */
  minTradeUsd: 1,
  /** A day counts towards D only if the group paid at least this much in fees that day (configurable, spec §4.2). */
  minDayFeesUsd: 0.1,
  /** D is capped here: C reaches 1.0 at 12 qualified days. */
  maxDays: 12,
  /** Payouts below this are carried to the next month (gas would eat them). */
  minPayoutUsd: 1,
});

/**
 * Test networks: the same formula with thresholds sized for test volumes (test coins have no value and test traders
 * trade for minutes, not weeks), as the holder threshold is ($25 mainnet, $0.25 testnet). Never used on a mainnet.
 */
export const EWPR_TESTNET_RULES = Object.freeze({
  ...EWPR_RULES,
  version: 'ewpr-1-testnet',
  minVolumeUsd: 1, minTrades: 2, minDays: 1, minWeeks: 1, minFeesUsd: 0.01, minTradeUsd: 0.01, minDayFeesUsd: 0.001, minPayoutUsd: 0.01,
});

/**
 * The first airdrop round paid by EWPR, per distributor schedule. Round 0 is November 2026 on every mainnet (genesis
 * 1 November 2026); no mainnet airdrop round had been posted when EWPR was approved, so it applies from the start.
 */
export const EWPR_FROM_ROUND = 0;

const DAY = 86_400;
const MICRO = 1_000_000;
const C_SCALE = 12_000n; // C × 12,000 = 9,600 + 200 × min(D, 12)

/** Integer n-th root (floor) of a non-negative BigInt. */
export function iroot(value, n) {
  value = BigInt(value);
  if (value < 0n) throw new Error('Negative.');
  if (value < 2n) return value;
  const k = BigInt(n);
  // Start above the root (from the bit length) and step down with Newton's method.
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / n));
  for (;;) {
    const y = ((k - 1n) * x + value / x ** (k - 1n)) / k;
    if (y >= x) break;
    x = y;
  }
  while (x ** k > value) x--;
  while ((x + 1n) ** k <= value) x++;
  return x;
}

/** C × 12,000 for D qualified days. */
export const consistencyScaled = (days, rules = EWPR_RULES) => 9_600n + 200n * BigInt(Math.min(Math.max(0, Math.floor(days)), rules.maxDays)) * 12n / BigInt(rules.maxDays);

/** The score of a group: floor(F^0.8) × C × 12,000, with F in micro-dollars. */
export function ewprScore(feesMicroUsd, days, rules = EWPR_RULES) {
  const f = BigInt(feesMicroUsd);
  if (f <= 0n) return 0n;
  return iroot(f ** 4n, 5) * consistencyScaled(days, rules);
}

/** UTC week index, weeks starting on Monday (1 Jan 1970 was a Thursday). */
const weekOf = ts => Math.floor((Math.floor(ts / DAY) + 3) / 7);

/**
 * Activity per trader group for one month. `trades`: [{ account, timestamp, feeUsd, valueUsd }] already inside the
 * window, creator-linked trades included (they mark the group). Returns Map(group → stats).
 */
export function groupActivity(trades, { groupOf = w => w, isCreatorLinked = () => false } = {}, rules = EWPR_RULES) {
  const groups = new Map();
  for (const t of trades) {
    const w = String(t.account), g = groupOf(w), fee = Number(t.feeUsd) || 0, value = Number(t.valueUsd) || 0;
    const x = groups.get(g) ?? { id: g, wallets: new Map(), feesUsd: 0, volumeUsd: 0, trades: 0, dayFees: new Map(), creatorLinked: false };
    x.creatorLinked ||= isCreatorLinked(w);
    if (fee > 0) {
      x.feesUsd += fee; x.volumeUsd += value;
      if (value >= rules.minTradeUsd) x.trades += 1;
      const day = Math.floor(t.timestamp / DAY);
      x.dayFees.set(day, (x.dayFees.get(day) ?? 0) + fee);
      x.wallets.set(w, (x.wallets.get(w) ?? 0) + fee);
    }
    groups.set(g, x);
  }
  for (const x of groups.values()) {
    const days = [...x.dayFees].filter(([, f]) => f + 1e-12 >= rules.minDayFeesUsd).map(([d]) => d);
    x.days = days.length;
    x.weeks = new Set(days.map(d => weekOf(d * DAY))).size;
  }
  return groups;
}

/** What a group has met and what it still needs; `eligible` only when every requirement is met. */
export function eligibility(stats, rules = EWPR_RULES) {
  const s = stats ?? { volumeUsd: 0, trades: 0, days: 0, weeks: 0, feesUsd: 0, creatorLinked: false };
  const checks = {
    volume: { have: s.volumeUsd, need: rules.minVolumeUsd, ok: s.volumeUsd >= rules.minVolumeUsd },
    trades: { have: s.trades, need: rules.minTrades, ok: s.trades >= rules.minTrades },
    days: { have: s.days, need: rules.minDays, ok: s.days >= rules.minDays },
    weeks: { have: s.weeks, need: rules.minWeeks, ok: s.weeks >= rules.minWeeks },
    fees: { have: s.feesUsd, need: rules.minFeesUsd, ok: s.feesUsd >= rules.minFeesUsd },
    independent: { ok: !s.creatorLinked },
  };
  return { checks, eligible: Object.values(checks).every(c => c.ok) };
}

/**
 * Splits `pool` (base units of the payout asset) among groups by score. `scored`: [{ id, score }]. Returns
 * { allocations: Map(id → amount), unallocated } with Σ allocations ≤ pool. No eligible group: nothing is allocated
 * and the whole pool stays for the next month (never sent to the treasury).
 */
export function allocateEwpr(pool, scored) {
  pool = BigInt(pool);
  if (pool < 0n) throw new Error('Invalid pool.');
  const seen = new Set(), list = [];
  for (const t of scored) {
    const id = String(t.id), score = BigInt(t.score);
    if (seen.has(id)) throw new Error(`Trader ${id} listed twice.`);
    seen.add(id);
    if (score > 0n) list.push({ id, score });
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = list.reduce((a, t) => a + t.score, 0n), allocations = new Map();
  if (total === 0n || pool === 0n) return { allocations, unallocated: pool };
  let given = 0n;
  for (const t of list) { const r = pool * t.score / total; if (r > 0n) { allocations.set(t.id, r); given += r; } }
  return { allocations, unallocated: pool - given };
}

/**
 * The month's scores from indexed trades. `trades`: [{ account, timestamp, feeRaw, quoteDecimals, asset, quoteUsd }];
 * `usdPerUnit(asset)`: dollars per whole unit at the round's end. `links`: [[a, b]] wallets that count as one;
 * `creatorLinked`: wallets linked to a token's creator; `exclude`: protocol contracts. Returns { groups, scored, wallets } where `wallets` is
 * [{ wallet, group, fees }] (fees in micro-dollars) for splitting each group's reward among its wallets.
 */
export function ewprScores({ trades, start, end, usdPerUnit, links = [], creatorLinked = [], exclude = [], rules = EWPR_RULES }) {
  const lower = a => (/^0x/i.test(String(a)) ? String(a).toLowerCase() : String(a));
  // Elpida's own contracts (the flywheel vault buys and burns, distributors, the router) are never traders.
  const skip = new Set(exclude.filter(Boolean).map(lower));
  const window = trades.filter(t => t.timestamp >= start && t.timestamp < end && t.account && !skip.has(lower(t.account)));
  const all = [...new Set([...window.map(t => lower(t.account)), ...creatorLinked.map(lower)])];
  const map = linkWallets(all, links), flagged = new Set(creatorLinked.map(w => map.get(lower(w))));
  const groupOf = w => map.get(lower(w)) ?? lower(w);
  const rows = window.map(t => {
    const unit = usdPerUnit(lower(t.asset)) ?? 0;
    return { account: lower(t.account), timestamp: t.timestamp, feeUsd: Number(BigInt(t.feeRaw ?? 0)) / 10 ** (t.quoteDecimals ?? 18) * unit, valueUsd: Number(t.quoteUsd ?? 0) };
  });
  const groups = groupActivity(rows, { groupOf, isCreatorLinked: w => flagged.has(groupOf(w)) }, rules);
  const scored = [], wallets = [];
  for (const g of groups.values()) {
    g.eligibility = eligibility(g, rules);
    g.multiplierScaled = consistencyScaled(g.days, rules);
    g.score = g.eligibility.eligible ? ewprScore(BigInt(Math.round(g.feesUsd * MICRO)), g.days, rules) : 0n;
    if (g.score > 0n) {
      scored.push({ id: g.id, score: g.score });
      for (const [wallet, fee] of g.wallets) wallets.push({ wallet, group: g.id, fees: BigInt(Math.round(fee * MICRO)) });
    }
  }
  return { groups, scored, wallets };
}
