// ELPIDA V2.0 keeper plans: what the keepers post and buy, computed from indexed chain data only, deterministically, so
// anyone can recompute every payout list and every flywheel order (Malik's decisions of 8–9 November 2026).
//
//  - Trader airdrop (monthly, per chain): each pool asset's airdrop funds go to qualifying traders by fees paid (in
//    dollars), with the 20% equal / 40% square root / 40% pro-rata blend and the 1% cap (v2-airdrop.mjs).
//  - Holder rewards: each token's 10% builds up and, once it reaches the threshold, goes to that token's holders by the
//    same blend over their time-weighted balance. Native pairs pay native, stock pairs pay the stock, USDC pairs are
//    converted to native first (the distributor's convertToNative).
//  - Flywheel: the top 10 V2 tokens by net buying from independent wallets over 7 days are bought and burned.
//  - Linked wallets count as one and creator-linked wallets are excluded everywhere. The linking rule (assumed, Malik
//    9 November): wallets first funded by the same personal wallet (never an exchange, faucet, bridge or other
//    service: LINK_RULES), and wallets that received a token directly from its creator.
import { AIRDROP_RULES, allocateAirdrop, linkWallets, qualifies, walletPayouts } from './v2-airdrop.mjs';

/**
 * Which first funders link wallets (Malik, 9 November: wallets funded by an exchange must not be joined). A funder
 * links the wallets it funded only if it looks like a person: not a contract (bridges, routers, exchange batchers),
 * fewer than `serviceNonce` transactions sent (exchange hot wallets, faucets and market makers send far more), not
 * on the operator's ignore list, and funding at most `maxFanOut` of the period's wallets (a backstop for services
 * that rotate fresh hot wallets).
 */
export const LINK_RULES = Object.freeze({ serviceNonce: 5_000, maxFanOut: 200 });

export function personalFunder({ code, nonce, ignored = false }, rules = LINK_RULES) {
  return !ignored && (!code || code === '0x') && Number(nonce) < rules.serviceNonce;
}

/** Drops links from funders that fund more than `maxFanOut` of these wallets. `links`: [[funder, wallet]]. */
export function boundedFunderLinks(links, rules = LINK_RULES) {
  const count = new Map();
  for (const [funder] of links) count.set(funder, (count.get(funder) ?? 0) + 1);
  return links.filter(([funder]) => count.get(funder) <= rules.maxFanOut);
}

export const HOLDER_RULES = Object.freeze({
  ...AIRDROP_RULES,
  /** A token's holder share is paid once it is worth at least this (spec §25; Malik to confirm). */
  thresholdUsd: { mainnet: 25, testnet: 0.25 },
  /** Holders must have held for at least this long in the period to count (blocks buy-snapshot-sell). */
  minHoldSeconds: 86_400,
});

export const FLYWHEEL_RULES = Object.freeze({
  windowSeconds: 7 * 86_400,
  top: 10,
  /** Distinct trader groups (not linked to the creator) buying a token in the window, for it to qualify. */
  minIndependentTraders: { mainnet: 10, testnet: 2 },
  /** Of each asset's flywheel balance per cycle, spread over the chosen tokens; each order stays within the vault's 10%. */
  cycleBps: 1000,
  /**
   * Price protection. The reference is the average execution price of the last hour (or the last five trades). An order
   * is skipped when the live quote is more than `maxPremiumBps` worse than the reference (a pumped or manipulated
   * pool), and is sent with a minimum of the live quote less `slippageBps`.
   */
  maxPremiumBps: 1000,
  slippageBps: 100,
  priceWindowSeconds: 3600,
});

// EVM addresses compare lowercase; Solana addresses (base58) are case-sensitive and stay as they are.
const lower = a => (/^0x/i.test(String(a)) ? String(a).toLowerCase() : String(a));
const DAY = 86_400;

/** Groups wallets by the linking rule; the creator-linked set grows to whole groups. */
export function linkGroups(wallets, { links = [], creatorLinked = [] } = {}) {
  const groups = linkWallets([...wallets, ...creatorLinked], links);
  const flagged = new Set([...creatorLinked].map(w => groups.get(lower(w))));
  return { groupOf: w => groups.get(lower(w)) ?? lower(w), isCreatorLinked: w => flagged.has(groups.get(lower(w)) ?? lower(w)) };
}

/**
 * The month's trader airdrop for one chain. `trades`: indexed trades ({ account, timestamp, feeRaw, quoteDecimals,
 * asset, quoteUsd }) with `quoteUsd` the trade's value in dollars; `usdPerUnit(asset)` dollars per whole unit of a pool
 * asset at the round's end; `firstSeen(wallet)` its first activity (seconds); `pools`: { asset: bigint } funds
 * available for this round (after amounts carried from earlier rounds); `carried`: { asset: Map(wallet → bigint) }.
 */
export function airdropRound({ trades, start, end, usdPerUnit, firstSeen, pools, carried = {}, links = [], creatorLinked = [], minPayoutUsd = AIRDROP_RULES.minPayoutUsd, rules = AIRDROP_RULES }) {
  const window = trades.filter(t => t.timestamp >= start && t.timestamp < end && t.account);
  const { groupOf, isCreatorLinked } = linkGroups(window.map(t => t.account), { links, creatorLinked });
  const groups = new Map(), wallets = new Map();
  for (const t of window) {
    const w = lower(t.account), g = groupOf(w), feeUsd = Number(BigInt(t.feeRaw ?? 0)) / 10 ** t.quoteDecimals * usdPerUnit(lower(t.asset));
    const x = groups.get(g) ?? { id: g, feesUsd: 0, volumeUsd: 0, days: new Set(), age: 0, creatorLinked: false, wallets: new Set() };
    x.feesUsd += feeUsd; x.volumeUsd += Number(t.quoteUsd ?? 0); x.days.add(Math.floor(t.timestamp / DAY)); x.wallets.add(w);
    x.age = Math.max(x.age, end - (firstSeen(w) ?? t.timestamp)); x.creatorLinked ||= isCreatorLinked(w);
    groups.set(g, x);
    wallets.set(w, { wallet: w, group: g, fees: (wallets.get(w)?.fees ?? 0n) + BigInt(Math.round(feeUsd * 1e6)) });
  }
  const qualified = [...groups.values()].filter(g => qualifies({ volumeUsd: g.volumeUsd, activeDays: g.days.size, walletAgeDays: g.age / DAY, creatorLinked: g.creatorLinked }, rules) && g.feesUsd > 0);
  const traders = qualified.map(g => ({ id: g.id, fees: BigInt(Math.round(g.feesUsd * 1e6)) }));
  const byAsset = {};
  for (const [asset, pool] of Object.entries(pools)) {
    const a = lower(asset), { allocations, unallocated } = allocateAirdrop(pool, traders, rules);
    const unit = usdPerUnit(a), decimals = trades.find(t => lower(t.asset) === a)?.quoteDecimals ?? 18;
    const min = unit > 0 ? BigInt(Math.ceil(minPayoutUsd / unit * 10 ** decimals)) : 0n;
    const { payouts, carried: next } = walletPayouts(allocations, [...wallets.values()].filter(w => allocations.has(w.group)), min, carried[a] ?? new Map());
    byAsset[a] = { payouts, carried: next, unallocated };
  }
  return { byAsset, traders: traders.length, groups: groups.size, qualified: qualified.map(g => g.id) };
}

/**
 * Seconds × balance held by each wallet in [start, end), from a token's Transfer events ({ from, to, amount, timestamp })
 * in order. Holdings shorter than `minHoldSeconds` in total do not count.
 */
export function timeWeightedBalances(transfers, start, end, { minHoldSeconds = 0 } = {}) {
  const balance = new Map(), since = new Map(), weight = new Map(), held = new Map();
  const touch = (w, t) => {
    const b = balance.get(w) ?? 0n, s = since.get(w) ?? t, from = BigInt(Math.max(s, start)), to = BigInt(Math.min(t, end));
    if (b > 0n && to > from) { weight.set(w, (weight.get(w) ?? 0n) + b * (to - from)); held.set(w, (held.get(w) ?? 0) + Number(to - from)); }
    since.set(w, t);
  };
  for (const x of transfers) {
    if (x.timestamp >= end) break;
    const from = lower(x.from), to = lower(x.to), n = BigInt(x.amount);
    touch(from, x.timestamp); touch(to, x.timestamp);
    balance.set(from, (balance.get(from) ?? 0n) - n); balance.set(to, (balance.get(to) ?? 0n) + n);
  }
  for (const w of balance.keys()) touch(w, end);
  return new Map([...weight].filter(([w, v]) => v > 0n && (held.get(w) ?? 0) >= minHoldSeconds));
}

/**
 * One token's holder payout once its share has built up: `pool` (base units) to holders by the blend over their
 * time-weighted balance. `excluded`: the pool manager, hook, router, zero and dead addresses and the like.
 */
export function holderRound({ transfers, start, end, pool, excluded = [], links = [], creatorLinked = [], rules = HOLDER_RULES }) {
  const skip = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', ...excluded].map(lower));
  const weights = timeWeightedBalances(transfers, start, end, { minHoldSeconds: rules.minHoldSeconds });
  const { groupOf, isCreatorLinked } = linkGroups([...weights.keys()], { links, creatorLinked });
  const groups = new Map(), wallets = [];
  for (const [w, v] of weights) {
    if (skip.has(w) || isCreatorLinked(w)) continue;
    const g = groupOf(w);
    groups.set(g, (groups.get(g) ?? 0n) + v); wallets.push({ wallet: w, group: g, fees: v });
  }
  const { allocations, unallocated } = allocateAirdrop(pool, [...groups].map(([id, fees]) => ({ id, fees })), rules);
  const { payouts } = walletPayouts(allocations, wallets.filter(w => allocations.has(w.group)), 0n);
  return { payouts, unallocated, holders: groups.size };
}

/**
 * The flywheel cycle's orders. `trades`: indexed trades ({ token, account, side, timestamp, quoteRaw, tokenRaw, asset,
 * quoteUsd }); `creatorLinkedOf(token)`: that token's creator-linked wallets; `balances`: { asset: bigint } in the vault.
 * Returns [{ token, asset, amountIn, minOut, netBuyUsd, traders }], largest first.
 */
export function flywheelOrders({ trades, now, balances, links = [], creatorLinkedOf = () => [], twapOf = () => null, network = 'testnet', rules = FLYWHEEL_RULES }) {
  const recent = trades.filter(t => t.timestamp >= now - rules.windowSeconds && t.timestamp < now && t.account);
  const byToken = new Map();
  for (const t of recent) {
    const k = lower(t.token);
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(t);
  }
  const ranked = [];
  for (const [token, list] of byToken) {
    const { groupOf, isCreatorLinked } = linkGroups(list.map(t => t.account), { links, creatorLinked: creatorLinkedOf(token) });
    let net = 0; const buyers = new Set();
    for (const t of list) {
      if (isCreatorLinked(t.account)) continue;
      const usd = Number(t.quoteUsd ?? 0);
      if (t.side === 'buy') { net += usd; buyers.add(groupOf(t.account)); } else net -= usd;
    }
    if (net > 0 && buyers.size >= rules.minIndependentTraders[network]) ranked.push({ token, asset: lower(list[0].asset), netBuyUsd: net, traders: buyers.size, list });
  }
  ranked.sort((a, b) => b.netBuyUsd - a.netBuyUsd || (a.token < b.token ? -1 : 1));
  const chosen = ranked.slice(0, rules.top), orders = [];
  for (const asset of new Set(chosen.map(c => c.asset))) {
    const mine = chosen.filter(c => c.asset === asset), balance = BigInt(balances[asset] ?? 0), budget = balance * BigInt(rules.cycleBps) / 10_000n;
    const total = mine.reduce((a, c) => a + c.netBuyUsd, 0), cap = balance / 10n;
    for (const c of mine) {
      let amountIn = BigInt(Math.floor(Number(budget) * c.netBuyUsd / total));
      if (amountIn > cap) amountIn = cap;
      // Reference price: the pool's time-weighted spot price over the last hour (quote per token, display units) when
      // the index has it; otherwise the average execution price of the last hour's (or the last five) trades.
      let expected;
      const twap = twapOf(c.token), decimals = c.list[0].quoteDecimals ?? 18;
      if (twap > 0) expected = BigInt(Math.floor(Number(amountIn) / 10 ** decimals / twap * 1e6)) * 10n ** 12n;
      else {
        const priced = c.list.filter(t => t.timestamp >= now - rules.priceWindowSeconds && BigInt(t.tokenRaw ?? 0) > 0n);
        const source = priced.length ? priced : c.list.filter(t => BigInt(t.tokenRaw ?? 0) > 0n).slice(-5);
        const q = source.reduce((a, t) => a + BigInt(t.quoteRaw), 0n), tk = source.reduce((a, t) => a + BigInt(t.tokenRaw), 0n);
        if (q === 0n) continue;
        expected = amountIn * tk / q;
      }
      if (amountIn === 0n || expected === 0n) continue;
      orders.push({ token: c.token, asset, amountIn, expectedOut: expected, minOut: expected * BigInt(10_000 - rules.maxPremiumBps) / 10_000n, netBuyUsd: c.netBuyUsd, traders: c.traders });
    }
  }
  return orders.sort((a, b) => b.netBuyUsd - a.netBuyUsd);
}
