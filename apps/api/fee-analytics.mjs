// Fees and revenue for the analytics page (14 Nov 2026, analytics step 2). Built only from confirmed indexed events:
//  - fees generated: every V2 trade's hook fee (the hook's Fee event), split by the fixed V2 shares
//    (creator 30 / trader airdrop 30 / flywheel 10 / holder rewards 10 / Elpida treasury 20);
//  - withdrawn: the hook's FeesWithdrawn payouts to each recipient (failed payouts listed apart);
//  - outstanding: each token's current hook ledger (owed), valued at today's price;
//  - launch fees: the factory's LaunchFeePaid events.
// Elpida's revenue = launch fees + the treasury's 20% of V2 fees. Mainnet and test networks are always reported apart and
// never added together: test-network amounts have no real value. Dollar values use the price at the hour of each trade
// or payout (PriceHistory); before the history exists the current price is used and the amount counts as "revalued".
// Tokens of older models (V1, Model 10, Model 11, Solana curves) have no five-way ledger: they are counted, not guessed.
import { formatUnits, parseUnits } from 'ethers';
import { V2_FEE_SPLIT, V2_MODEL } from '../../packages/core/v2-economics.mjs';
import { usdReferenceFor } from '../../packages/core/pairs.mjs';

export const FEE_SHARES = Object.freeze(['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury']);
const WINDOWS = { '24h': 86400, '7d': 604800, '30d': 2592000, all: Infinity }, BPS = 10_000n;
const ZERO = '0x0000000000000000000000000000000000000000';

function emptyGroup() {
  const share = () => ({ earnedUsd: 0, withdrawnUsd: 0, outstandingUsd: 0, failedPayouts: 0 });
  return { feesGeneratedUsd: 0, launchFeesUsd: 0, launches: 0, revenueUsd: 0, revenueCollectedUsd: 0, trades: 0,
    shares: Object.fromEntries(FEE_SHARES.map(k => [k, share()])),
    valuation: { atTradeTime: 0, revalued: 0, unpriced: 0 }, untracked: [] };
}

/**
 * `sources`: [{ key, name, mainnet, tokens (listings), trades (iterable of trade rows), launchFees: { complete, rows },
 * feePayouts: [rows] }]. `priceHistory`: { usdAt(network, asset, ts) } or null. `prices`: the price keeper's snapshot.
 */
export function feeAnalytics({ sources, priceHistory = null, prices = {}, period = '7d', network = 'all', now = Math.floor(Date.now() / 1000) }) {
  if (!(period in WINDOWS)) throw new Error('Choose 24h, 7d, 30d or all.');
  if (network !== 'all' && !sources.some(s => s.key === network)) throw new Error('Unknown analytics network.');
  const start = now - WINDOWS[period], groups = { mainnet: emptyGroup(), testnet: emptyGroup() }, networks = [];
  for (const source of sources.filter(s => network === 'all' || s.key === network)) {
    const group = groups[source.mainnet ? 'mainnet' : 'testnet'], tokens = new Map(), untracked = new Map();
    const currentUsd = (t) => {
      const ref = usdReferenceFor({ ...t, network: source.key }, prices?.[source.key] ?? null, now);
      return ref?.status === 'fresh' && Number(ref.usd) > 0 ? Number(ref.usd) : null;
    };
    // The USD price of `amount` units of `asset` at `ts`: the hourly history first, else today's price ("revalued").
    const value = (asset, amount, ts, current) => {
      const past = priceHistory?.usdAt(source.key, asset, ts);
      if (past > 0) { group.valuation.atTradeTime++; return amount * past; }
      if (current > 0) { group.valuation.revalued++; return amount * current; }
      group.valuation.unpriced++; return 0;
    };
    for (const t of source.tokens ?? []) {
      if (t.model !== V2_MODEL) { const m = t.model ?? (t.curveModel ? `model-${t.curveModel}` : 'v1'); untracked.set(m, (untracked.get(m) ?? 0) + 1); continue; }
      const native = t.pair === 'native' || !t.quoteAddress || String(t.quoteAddress).toLowerCase() === ZERO;
      tokens.set(String(t.address).toLowerCase(), { t, d: Number(t.quoteDecimals ?? 18), asset: native ? 'native' : String(t.quoteAddress).toLowerCase(), current: currentUsd(t), feeRaw: 0n });
    }
    const net = { key: source.key, name: source.name, mainnet: !!source.mainnet, v2Tokens: tokens.size, launchFeesComplete: source.launchFees?.complete !== false, reconciliation: [] };
    for (const trade of source.trades ?? []) {
      const x = tokens.get(String(trade.token).toLowerCase()); if (!x || !trade.feeRaw) continue;
      const fee = BigInt(trade.feeRaw); if (fee <= 0n) continue;
      x.feeRaw += fee;
      if (trade.timestamp < start || trade.timestamp > now) continue;
      group.trades++;
      const asUsd = value(x.asset, Number(formatUnits(fee, x.d)), trade.timestamp, x.current);
      group.feesGeneratedUsd += asUsd;
      for (const k of FEE_SHARES) group.shares[k].earnedUsd += asUsd * V2_FEE_SPLIT[k] / 10_000;
    }
    for (const p of source.feePayouts ?? []) {
      const x = tokens.get(String(p.token).toLowerCase()), k = FEE_SHARES[p.recipient]; if (!x || !k) continue;
      if (p.timestamp < start || p.timestamp > now) continue;
      if (p.failed) { group.shares[k].failedPayouts++; continue; }
      group.shares[k].withdrawnUsd += value(x.asset, Number(formatUnits(BigInt(p.amountRaw), x.d)), p.timestamp, x.current);
    }
    for (const x of tokens.values()) {
      const owed = x.t.feeLedgers?.owed; if (!owed) continue;
      for (const k of FEE_SHARES) group.shares[k].outstandingUsd += (x.current ?? 0) * Math.max(0, Number(owed[k]) || 0);
      // Reconciliation: the fees counted from trades against the hook's own running total for the token.
      if (x.t.accrued != null) {
        const ledger = parseUnits(String(x.t.accrued), x.d);
        net.reconciliation.push({ token: x.t.address, symbol: x.t.metadata?.symbol ?? x.t.symbol ?? null, fromTradesRaw: x.feeRaw.toString(), ledgerRaw: ledger.toString(), differenceRaw: (ledger - x.feeRaw).toString(), indexedBlock: x.t.indexedBlock ?? null });
      }
    }
    for (const f of source.launchFees?.rows ?? []) {
      if (f.timestamp < start || f.timestamp > now) continue;
      const native = !f.asset || String(f.asset).toLowerCase() === ZERO, amount = Number(formatUnits(BigInt(f.amountRaw), native ? 18 : 6));
      // A non-native launch fee is paid in the factory's USDC (ElpidaUsdPricing), so it is worth its face value.
      group.launchFeesUsd += native ? value('native', amount, f.timestamp, currentUsd({ pair: 'native' })) : amount;
      group.launches++;
    }
    net.untracked = [...untracked].map(([model, tokens]) => ({ model, tokens }));
    group.untracked.push(...net.untracked.map(u => ({ network: source.key, ...u })));
    networks.push(net);
  }
  for (const g of Object.values(groups)) {
    g.revenueUsd = g.launchFeesUsd + g.shares.treasury.earnedUsd;
    g.revenueCollectedUsd = g.launchFeesUsd + g.shares.treasury.withdrawnUsd;
  }
  return { period, network, updatedAt: now, mainnet: groups.mainnet, testnet: groups.testnet, networks,
    split: Object.fromEntries(FEE_SHARES.map(k => [k, V2_FEE_SPLIT[k] / Number(BPS)])),
    pricesSince: priceHistory?.since?.() ?? null,
    basis: 'Confirmed indexed events only. Fees generated are V2 hook fees, split by the fixed V2 shares. Revenue is launch fees plus the treasury share. Withdrawn amounts are payouts from the hook to each recipient; outstanding is what the hook still owes, at today\'s price. Dollar values use the price at the hour of each event where recorded, otherwise today\'s price (revalued). Test-network amounts have no real value and are never added to mainnet. Older models\' fees are not tracked here.' };
}
