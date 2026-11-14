// Fees and revenue for the analytics page (14 Nov 2026, analytics step 2). Built only from confirmed indexed events:
//  - fees generated: every V2 trade's hook fee (the hook's Fee event), split by the fixed V2 shares
//    (creator 30 / trader airdrop 30 / flywheel 10 / holder rewards 10 / Elpida treasury 20);
//  - withdrawn: the hook's FeesWithdrawn payouts to each recipient (failed payouts listed apart);
//  - outstanding: each token's current hook ledger (owed), valued at today's price;
//  - launch fees: the factory's LaunchFeePaid events.
// Elpida's revenue = launch fees + the treasury's 20% of V2 fees. Mainnet and test networks are always reported apart and
// never added together: test-network amounts have no real value. Dollar values use the price at the hour of each trade
// or payout (PriceHistory); before the history exists the current price is used and the amount counts as "revalued".
// Model 10 curves (15 Nov 2026): the curve emits no fee, so each curve trade's base fee (1.25%) is recomputed exactly as the
// contract does (buy: of the quote spent; sell: of the gross, rebuilt from the amount paid out and the fee rate at that
// second); creator 50%, Elpida the rest less any partner buyback burn. The anti-snipe surplus is locked liquidity, not a fee.
// Fees of a graduated Model 10 pool, Model 11, Solana curves and older models are counted as tokens, not guessed.
import { formatUnits, parseUnits } from 'ethers';
import { V2_FEE_SPLIT, V2_MODEL } from '../../packages/core/v2-economics.mjs';
import { DEX_MODEL } from '../../packages/core/curve-model.mjs';
import { usdReferenceFor } from '../../packages/core/pairs.mjs';

export const FEE_SHARES = Object.freeze(['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury']);
/** Shares a Model 10 curve fee can go to: the creator, a partner token's buyback burn, and Elpida. */
const ALL_SHARES = [...FEE_SHARES, 'buybackBurn'];
const WINDOWS = { '24h': 86400, '7d': 604800, '30d': 2592000, all: Infinity }, BPS = 10_000n;
const ZERO = '0x0000000000000000000000000000000000000000';

function emptyGroup() {
  const share = () => ({ earnedUsd: 0, withdrawnUsd: 0, outstandingUsd: 0, failedPayouts: 0 });
  return { feesGeneratedUsd: 0, launchFeesUsd: 0, launches: 0, revenueUsd: 0, revenueCollectedUsd: 0, trades: 0,
    shares: Object.fromEntries(ALL_SHARES.map(k => [k, share()])), byModel: {},
    valuation: { atTradeTime: 0, revalued: 0, unpriced: 0 }, untracked: [] };
}

/** The Model 10 fee rate (bps) at `timestamp`: linear decay from the anti-snipe start to the base over the window. */
export function model10FeeBps(t, timestamp) {
  const s = t.feeSchedule ?? {}, base = BigInt(s.base ?? 125), start = BigInt(s.start ?? 9000), window = BigInt(s.window ?? 60);
  const elapsed = BigInt(Math.max(0, Number(timestamp) - Number(t.launchedAt ?? 0)));
  return elapsed >= window ? base : base + (start - base) * (window - elapsed) / window;
}
/**
 * One Model 10 curve trade's base fee and its parts, as ElpidaDexCurve charges them. Buy: base = spent x 1.25%. Sell: the
 * event gives out = gross - floor(gross x rate); the smallest gross that pays exactly `out` is rebuilt (within 1 wei).
 */
export function model10TradeFee(t, trade) {
  const q = BigInt(trade.quoteRaw ?? 0), baseBps = BigInt(t.feeSchedule?.base ?? 125); if (q <= 0n) return null;
  let gross = q;
  if (trade.side === 'sell') {
    const bps = model10FeeBps(t, trade.timestamp), net = g => g - g * bps / BPS;
    gross = q * BPS / (BPS - bps); while (gross > 0n && net(gross - 1n) >= q) gross--; while (net(gross) < q) gross++;
  }
  const base = gross * baseBps / BPS, creator = base - base / 2n, burn = base * BigInt(t.buybackBps ?? 0) / BPS;
  return { base, creator, burn, treasury: base - creator - burn };
}
const isModel10 = t => t.curveModel === 10 && (t.deploymentModel ?? DEX_MODEL) === DEX_MODEL && !!t.curve;
const modelOf = t => t.model === V2_MODEL ? 'v2' : isModel10(t) ? 'model10' : t.model ?? t.deploymentModel ?? (t.curveModel ? `model-${t.curveModel}` : 'v1');

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
    const model = name => group.byModel[name] ??= { feesGeneratedUsd: 0, trades: 0, tokens: 0 };
    for (const t of source.tokens ?? []) {
      const m = modelOf(t);
      if (m !== 'v2' && m !== 'model10') { untracked.set(m, (untracked.get(m) ?? 0) + 1); continue; }
      const native = t.pair === 'native' || !t.quoteAddress || String(t.quoteAddress).toLowerCase() === ZERO;
      tokens.set(String(t.address).toLowerCase(), { t, m, d: Number(t.quoteDecimals ?? 18), asset: native ? 'native' : String(t.quoteAddress).toLowerCase(), current: currentUsd(t), feeRaw: 0n, withdrawnRaw: 0n });
      model(m).tokens++;
    }
    const net = { key: source.key, name: source.name, mainnet: !!source.mainnet, v2Tokens: [...tokens.values()].filter(x => x.m === 'v2').length,
      model10Tokens: [...tokens.values()].filter(x => x.m === 'model10').length, launchFeesComplete: source.launchFees?.complete !== false, reconciliation: [] };
    for (const trade of source.trades ?? []) {
      const x = tokens.get(String(trade.token).toLowerCase()); if (!x) continue;
      let fee, parts;
      if (x.m === 'v2') { if (!trade.feeRaw) continue; fee = BigInt(trade.feeRaw); parts = Object.fromEntries(FEE_SHARES.map(k => [k, V2_FEE_SPLIT[k] / 10_000])); }
      else {
        // Only trades on the curve itself carry the curve fee; a graduated pool's LP fees are not counted here.
        if (String(trade.market ?? '').toLowerCase() !== x.t.curve) continue;
        const f = model10TradeFee(x.t, trade); if (!f || f.base <= 0n) continue;
        fee = f.base; parts = { creator: Number(f.creator) / Number(f.base), treasury: Number(f.treasury) / Number(f.base), buybackBurn: Number(f.burn) / Number(f.base) };
        x.creatorRaw = (x.creatorRaw ?? 0n) + f.creator; x.treasuryRaw = (x.treasuryRaw ?? 0n) + f.treasury;
      }
      if (fee <= 0n) continue;
      x.feeRaw += fee;
      if (trade.timestamp < start || trade.timestamp > now) continue;
      group.trades++; model(x.m).trades++;
      const asUsd = value(x.asset, Number(formatUnits(fee, x.d)), trade.timestamp, x.current);
      group.feesGeneratedUsd += asUsd; model(x.m).feesGeneratedUsd += asUsd;
      for (const [k, part] of Object.entries(parts)) group.shares[k].earnedUsd += asUsd * part;
    }
    for (const p of source.feePayouts ?? []) {
      const x = tokens.get(String(p.token).toLowerCase()), k = FEE_SHARES[p.recipient]; if (!x || !k) continue;
      if (!p.failed) x.withdrawnRaw += BigInt(p.amountRaw);
      if (p.timestamp < start || p.timestamp > now) continue;
      if (p.failed) { group.shares[k].failedPayouts++; continue; }
      group.shares[k].withdrawnUsd += value(x.asset, Number(formatUnits(BigInt(p.amountRaw), x.d)), p.timestamp, x.current);
    }
    for (const x of tokens.values()) {
      const symbol = x.t.metadata?.symbol ?? x.t.symbol ?? null, row = (ledger, basis) => net.reconciliation.push({ token: x.t.address, symbol, model: x.m, basis,
        fromTradesRaw: x.feeRaw.toString(), ledgerRaw: ledger.toString(), differenceRaw: (ledger - x.feeRaw).toString(), indexedBlock: x.t.indexedBlock ?? null });
      if (x.m === 'v2') {
        const owed = x.t.feeLedgers?.owed; if (!owed) continue;
        for (const k of FEE_SHARES) group.shares[k].outstandingUsd += (x.current ?? 0) * Math.max(0, Number(owed[k]) || 0);
        // Reconciliation: the fees counted from trades against the hook's own running total for the token.
        if (x.t.accrued != null) row(parseUnits(String(x.t.accrued), x.d), 'hook accrued');
      } else {
        const c = Math.max(0, Number(x.t.creatorFees) || 0), pr = Math.max(0, Number(x.t.protocolFees) || 0);
        group.shares.creator.outstandingUsd += (x.current ?? 0) * c; group.shares.treasury.outstandingUsd += (x.current ?? 0) * pr;
        // The curve keeps no running total: what it still owes plus what it paid out, against the creator and treasury
        // parts counted from trades (a buyback burn is spent at once, so it is left out of both sides).
        if (x.t.creatorFees != null && x.t.protocolFees != null) {
          const ledger = parseUnits(String(x.t.creatorFees), x.d) + parseUnits(String(x.t.protocolFees), x.d) + x.withdrawnRaw;
          x.feeRaw = (x.creatorRaw ?? 0n) + (x.treasuryRaw ?? 0n); row(ledger, 'curve owed + paid out');
        }
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
    split: Object.fromEntries(FEE_SHARES.map(k => [k, V2_FEE_SPLIT[k] / Number(BPS)])), model10Split: { creator: 0.5, treasury: 0.5, note: 'a partner token\'s buyback burn comes out of Elpida\'s half' },
    pricesSince: priceHistory?.since?.() ?? null,
    basis: 'Confirmed indexed events only. Fees generated are V2 hook fees, split by the fixed V2 shares, and Model 10 curve fees (1.25% base, recomputed per trade as the curve charges it), half to the creator and half to Elpida. Anti-snipe surplus is locked liquidity, not a fee. Revenue is launch fees plus the treasury share. Withdrawn amounts are payouts from the hook to each recipient; outstanding is what the hook still owes, at today\'s price. Dollar values use the price at the hour of each event where recorded, otherwise today\'s price (revalued). Test-network amounts have no real value and are never added to mainnet. Graduated Model 10 pool fees, Model 11, Solana and older models are not tracked here yet.' };
}
