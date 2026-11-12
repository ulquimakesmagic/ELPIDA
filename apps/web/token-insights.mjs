// Pure helpers behind the token page: who-filters for the trades table, top traders, chart trade markers,
// the safety checklist and quick buy amounts. No DOM, no network: everything here is derived from rows the
// page already fetched (indexed trades and holders) and from the token record, so it can be tested directly.

import { flywheelCheck } from './burn-labels.mjs';
import { testStockStatus, TEST_STOCK_PROVIDERS } from './test-stock.mjs';

const lower = value => String(value ?? '').toLowerCase();
const amountOf = row => { const v = Number(row?.quoteAmount); return Number.isFinite(v) && v > 0 ? v : 0; };

/** Trades at or above the 90th percentile of quote size: the largest tenth, at least one trade. */
export function largeTradeThreshold(rows) {
  const sizes = rows.map(amountOf).filter(v => v > 0).sort((a, b) => b - a);
  if (!sizes.length) return null;
  return sizes[Math.max(0, Math.ceil(sizes.length * 0.1) - 1)];
}

export const WHO = ['all', 'dev', 'mine', 'large'];

/** Narrow trades to the creator's, the viewer's or the largest tenth. `side` filtering stays in trade-filter.mjs. */
export function filterByWho(rows, who = 'all', { creator, me } = {}) {
  if (!WHO.includes(who)) throw new Error('Choose All, Dev, Mine or Large.');
  if (who === 'all') return rows;
  if (who === 'dev') return creator ? rows.filter(row => lower(row.account) === lower(creator)) : [];
  if (who === 'mine') return me ? rows.filter(row => lower(row.account) === lower(me)) : [];
  const threshold = largeTradeThreshold(rows);
  return threshold === null ? [] : rows.filter(row => amountOf(row) >= threshold);
}

/**
 * Per-wallet totals over the indexed trades, largest volume first. Amounts are in the trading-pair asset.
 * `net` is what the wallet took out minus what it put in (sells minus buys), so a positive value is profit
 * realised so far, ignoring tokens still held.
 */
export function topTraders(rows, limit = 20) {
  const byAccount = new Map();
  for (const row of rows) {
    if (!row?.account) continue;
    const key = lower(row.account);
    const entry = byAccount.get(key) ?? { account: row.account, bought: 0, sold: 0, buys: 0, sells: 0, tokensBought: 0, tokensSold: 0 };
    const quote = amountOf(row), tokens = Number(row.tokenAmount) || 0;
    if (row.side === 'buy') { entry.bought += quote; entry.buys++; entry.tokensBought += tokens; }
    else if (row.side === 'sell') { entry.sold += quote; entry.sells++; entry.tokensSold += tokens; }
    byAccount.set(key, entry);
  }
  return [...byAccount.values()]
    .map(entry => ({ ...entry, volume: entry.bought + entry.sold, net: entry.sold - entry.bought, trades: entry.buys + entry.sells }))
    .sort((a, b) => b.volume - a.volume || b.trades - a.trades)
    .slice(0, limit);
}

/**
 * Chart markers for the creator's and the viewer's trades, snapped to the candle bucket the indexer uses
 * (floor(timestamp / interval) * interval). One marker per bucket, side and owner, so a burst of trades does not
 * stack dozens of labels. Buys sit below the candle, sells above it. A trade that is both the dev's and the
 * viewer's (the creator viewing their own token) is shown once, as the dev's.
 */
export function tradeMarkers(rows, { creator, me, interval = 60, showDev = true, showMine = true } = {}) {
  const seen = new Set(), markers = [];
  for (const row of rows) {
    const timestamp = Number(row?.timestamp);
    if (!Number.isFinite(timestamp) || (row.side !== 'buy' && row.side !== 'sell')) continue;
    const account = lower(row.account), dev = showDev && creator && account === lower(creator), mine = showMine && me && account === lower(me);
    if (!dev && !mine) continue;
    const owner = dev ? 'dev' : 'mine', time = Math.floor(timestamp / interval) * interval, key = `${time}:${row.side}:${owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ time, side: row.side, owner, position: row.side === 'buy' ? 'belowBar' : 'aboveBar', text: owner === 'dev' ? 'D' : row.side === 'buy' ? 'B' : 'S' });
  }
  return markers.sort((a, b) => a.time - b.time);
}

const pct = value => `${Number(Number(value).toFixed(2))}%`;

/** Holders that are wallets: the curve, the DEX pool and burn addresses are excluded. */
export function walletHolders(holders, token = {}) {
  const skip = new Set([token.curve, token.pool].filter(Boolean).map(lower));
  return (holders ?? []).filter(row => {
    const address = lower(row?.address);
    return address && !skip.has(address) && !/^0x0{40}$|^0x0{36}dead$/.test(address);
  });
}

/** Share of total supply held by the ten largest wallets, as a percentage, or null without holder data. */
export function topTenShare(holders, token = {}) {
  if (!Array.isArray(holders)) return null;
  const wallets = walletHolders(holders, token).map(row => Number(row.supplyShare) || 0).sort((a, b) => b - a).slice(0, 10);
  return wallets.reduce((sum, share) => sum + share, 0) * 100;
}

// Above these, a holding is worth a second look; they flag, they do not judge.
export const DEV_HOLDING_WARN = 5;
export const TOP_TEN_WARN = 30;

/**
 * The safety checklist. Every line is a fact the contracts guarantee or a number from indexed data; nothing is
 * shown that the page cannot back up. `ok: false` lines are warnings, not verdicts.
 */
/**
 * The issuer line for a token paired with a test Ondo-style stock: who controls the pair asset, and whether its
 * price lets the curve graduate right now. Null for any other pair.
 */
export function stockCheck(token, now) {
  if (!token?.stock) return null;
  const s = testStockStatus(token.stock, now), who = TEST_STOCK_PROVIDERS[token.stock.provider] ?? 'its issuer', q = token.quoteSymbol ?? 'the stock';
  const base = `Paired with ${q}, a test stand-in for an Ondo stock (${who}): the issuer can pause it or block wallets.`;
  return s.usable ? { ok: true, text: `${base} Stock price $${Number(token.stock.price).toLocaleString()}, fresh.` } : { ok: false, text: `${base} ${s.reason}` };
}
const isV2 = t => t?.deploymentModel === 'v2-hook' || t?.model === 'v2-hook';
const isV4 = t => /^v4|model-11/.test(String(t?.deploymentModel ?? t?.model ?? ''));
export function safetyChecks(token, { holders, dex } = {}) {
  const checks = [{ ok: true, text: 'Fixed supply of 1B. No mint and no owner after launch.' }];
  const venue = dex && dex !== 'test' ? dex : 'the DEX pool', v2 = isV2(token);
  // The token's own fee, never a fixed 1.25% (audit WEB-03): V2 tokens pick 1–4% at launch.
  const fee = `${pct((token.feeBps ?? 125) / 100)}`; // V2 tokens always carry feeBps; 1.25% is V2's default
  checks.push(v2 || isV4(token)
    ? { ok: true, text: 'Liquidity is locked from launch in its Uniswap v4 pool; nobody can add or remove it.' }
    : token.graduated
      ? { ok: true, text: `Liquidity on ${venue} is locked permanently.` }
      : { ok: true, text: `Liquidity is locked permanently when it graduates to ${venue}.` });
  if (token.tax) checks.push({ ok: false, text: `Buy tax ${pct(token.tax.buyBps / 100)}, sell tax ${pct(token.tax.sellBps / 100)}, fixed at launch.` });
  else if (v2) checks.push({ ok: true, text: `No buy or sell tax. Every trade pays this token's ${fee} fee, before and after graduation; it can never change.` });
  else {
    // Other models: state a fee only when the token declares one (from #231: never invent a fee for a token).
    const own = Number(token.feeBps ?? token.feeSchedule?.base) > 0 ? `${pct(Number(token.feeBps ?? token.feeSchedule.base) / 100)}` : null;
    checks.push({ ok: true, text: token.graduated || !own ? 'No buy or sell tax.' : `No buy or sell tax. The curve fee is ${own} per trade.` });
  }
  const burn = flywheelCheck(token);
  if (burn) checks.push(burn);
  const stock = stockCheck(token);
  if (stock) checks.push(stock);
  if (token.metadataURI) checks.push({ ok: true, text: 'Details were published at launch and cannot be edited.' });
  if (token.devBoughtPct != null) {
    const holds = token.devHoldingPct;
    const text = holds == null ? `Dev bought ${pct(token.devBoughtPct)} at launch.` : `Dev bought ${pct(token.devBoughtPct)} at launch and holds ${pct(holds)} now.`;
    checks.push({ ok: Number(holds ?? token.devBoughtPct) <= DEV_HOLDING_WARN, text });
  }
  const top = topTenShare(holders, token);
  if (top !== null && walletHolders(holders, token).length) checks.push({ ok: top <= TOP_TEN_WARN, text: `Top 10 wallets hold ${pct(top)} of supply.` });
  return checks;
}

// Quick buy amounts in the trading-pair asset. Small on purpose: these are one-tap sizes, not advice.
const QUICK = { ETH: ['0.001', '0.005', '0.01'], WETH: ['0.001', '0.005', '0.01'], BNB: ['0.01', '0.05', '0.1'], SOL: ['0.1', '0.5', '1'], USDC: ['5', '10', '25'] };
export function quickAmounts(symbol) {
  return QUICK[String(symbol ?? '').toUpperCase()] ?? [];
}
