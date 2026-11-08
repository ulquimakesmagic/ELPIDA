// ELPIDA V2.0 monthly trader airdrop (spec §13; Malik, 8 November 2026). Reference allocation, exact in BigInt, so the
// keeper's payout list (and its Merkle root) can be recomputed by anyone from the month's indexed trades.
//
// Small traders come first, and big traders are still rewarded. Each month, per chain, the airdrop pool is split:
//   20% equally among every qualifying trader,
//   40% by the square root of the fees each paid,
//   40% in proportion to the fees each paid,
// with no trader receiving more than 1% of the pool (20× the average share while fewer than ~2,000 traders qualify);
// the excess goes back to everyone else by the same formula.
// A "trader" is a group of linked wallets (same funding source and similar links), so splitting one wallet into many
// earns almost nothing. Creator-linked wallets are excluded (decision C9). Simulation (30,000 traders, top 1% paying 56%
// of fees): the median trader gets 4.3× what plain pro-rata gives, the bottom half gets 18% of the pool instead of
// 2%, and traders of $1k / $10k / $100k a month get back about 50% / 23% / 16% of their fees.

export const AIRDROP_RULES = Object.freeze({
  equalBps: 2_000,
  sqrtBps: 4_000,
  proRataBps: 4_000,
  /**
   * No trader (linked group) receives more than 1% of the month's pool, or 20 times the average share when fewer
   * than about 2,000 traders qualify (otherwise, in a young market, the cap would bind on everyone and flatten the
   * formula into equal shares).
   */
  traderCapBps: 100,
  capAverageMultiple: 20,
  /** Qualification for the month: real activity, not a wallet made for the drop. */
  minVolumeUsd: 20,
  minActiveDays: 2,
  minWalletAgeDays: 7,
  /** Payouts below this are carried to the next month instead of being sent (gas would eat them). */
  minPayoutUsd: 1,
});

const BPS = 10_000n;

/** Whether a trader group qualifies this month. Creator-linked groups never do. */
export function qualifies({ volumeUsd, activeDays, walletAgeDays, creatorLinked = false }, rules = AIRDROP_RULES) {
  return !creatorLinked && Number(volumeUsd) >= rules.minVolumeUsd && Number(activeDays) >= rules.minActiveDays && Number(walletAgeDays) >= rules.minWalletAgeDays;
}

/**
 * Groups wallets that are linked (pairs such as [funder, funded]) so each group counts as one trader. Returns
 * Map(wallet → group id), the group id being the group's lowest wallet address (lower-cased), so it is deterministic.
 */
export function linkWallets(wallets, links = []) {
  const parent = new Map();
  const find = a => { let r = a; while (parent.get(r) !== r) r = parent.get(r); let x = a; while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } return r; };
  const add = a => { a = String(a).toLowerCase(); if (!parent.has(a)) parent.set(a, a); return a; };
  for (const w of wallets) add(w);
  for (const [x, y] of links) {
    const a = find(add(x)), b = find(add(y));
    if (a !== b) a < b ? parent.set(b, a) : parent.set(a, b);
  }
  const out = new Map();
  for (const w of wallets) out.set(String(w).toLowerCase(), find(String(w).toLowerCase()));
  return out;
}

/** Integer square root (floor). */
export function isqrt(n) {
  if (n < 0n) throw new Error('Negative.');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))), y;
  while (x * x > n) x--;
  while ((y = x + 1n) * y <= n) x = y;
  return x;
}

/**
 * Splits `pool` (base units of the payout asset) among qualifying trader groups. `traders`: [{ id, fees }] with fees
 * in one unit for everyone (USD micro-units of fees paid this month). Returns { allocations: Map(id → amount),
 * unallocated } where unallocated is rounding dust, carried to next month. Deterministic: same inputs, same output.
 */
export function allocateAirdrop(pool, traders, rules = AIRDROP_RULES) {
  pool = BigInt(pool);
  if (pool < 0n) throw new Error('Invalid pool.');
  if (rules.equalBps + rules.sqrtBps + rules.proRataBps !== 10_000) throw new Error('Airdrop parts must total 10,000 bps.');
  const ids = new Set();
  const list = traders.map(t => ({ id: String(t.id), fees: BigInt(t.fees) })).filter(t => t.fees > 0n);
  for (const t of list) { if (ids.has(t.id)) throw new Error(`Trader ${t.id} listed twice.`); ids.add(t.id); }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const average = list.length ? pool / BigInt(list.length) : 0n, byShare = pool * BigInt(rules.traderCapBps) / BPS;
  const cap = byShare > average * BigInt(rules.capAverageMultiple) ? byShare : average * BigInt(rules.capAverageMultiple);
  const allocations = new Map();
  let open = list, remaining = pool;
  // Capped traders are fixed at the cap; the rest of the pool is shared again among the others, until nobody is over.
  for (;;) {
    if (!open.length || remaining === 0n) break;
    const shares = shareOut(remaining, open, rules);
    const over = open.filter((t, i) => shares[i] > cap);
    if (!over.length) { open.forEach((t, i) => allocations.set(t.id, shares[i])); break; }
    for (const t of over) { allocations.set(t.id, cap); remaining -= cap; }
    const capped = new Set(over.map(t => t.id));
    open = open.filter(t => !capped.has(t.id));
  }
  let given = 0n;
  for (const v of allocations.values()) given += v;
  return { allocations, unallocated: pool - given };
}

function shareOut(amount, traders, rules) {
  const equal = amount * BigInt(rules.equalBps) / BPS, root = amount * BigInt(rules.sqrtBps) / BPS, linear = amount - equal - root;
  const n = BigInt(traders.length);
  // Square roots of fees scaled by 1e6 keep precision for small fee amounts.
  const roots = traders.map(t => isqrt(t.fees * 1_000_000n));
  const sumRoots = roots.reduce((a, b) => a + b, 0n), sumFees = traders.reduce((a, t) => a + t.fees, 0n);
  return traders.map((t, i) => equal / n + (sumRoots ? root * roots[i] / sumRoots : 0n) + (sumFees ? linear * t.fees / sumFees : 0n));
}

/**
 * Splits a group's allocation among its wallets in proportion to the fees each paid (the remainder to the wallet that
 * paid most), and holds back payouts below the minimum: they carry to next month. `wallets`: [{ wallet, group, fees }].
 * `minPayout` is in the payout asset's base units. Returns { payouts: Map(wallet → amount), carried: Map(wallet → amount) }.
 */
export function walletPayouts(allocations, wallets, minPayout = 0n, carriedIn = new Map()) {
  const byGroup = new Map();
  for (const w of wallets) { const g = String(w.group); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push({ wallet: String(w.wallet).toLowerCase(), fees: BigInt(w.fees) }); }
  const payouts = new Map(), carried = new Map();
  const credit = (wallet, amount) => {
    const total = amount + (carriedIn.get(wallet) ?? 0n);
    if (total === 0n) return;
    if (total < BigInt(minPayout)) carried.set(wallet, total); else payouts.set(wallet, total);
  };
  for (const [group, amount] of allocations) {
    const members = (byGroup.get(group) ?? []).sort((a, b) => (b.fees > a.fees ? 1 : b.fees < a.fees ? -1 : a.wallet < b.wallet ? -1 : 1));
    if (!members.length) throw new Error(`Group ${group} has no wallets.`);
    const fees = members.reduce((a, m) => a + m.fees, 0n);
    let left = amount;
    const parts = members.map(m => { const p = fees ? amount * m.fees / fees : 0n; left -= p; return p; });
    parts[0] += left;
    members.forEach((m, i) => credit(m.wallet, parts[i]));
  }
  // Wallets with an earlier balance but no allocation this month keep it (paid once it reaches the minimum).
  for (const wallet of carriedIn.keys()) if (!payouts.has(wallet) && !carried.has(wallet)) credit(wallet, 0n);
  return { payouts, carried };
}
