// Stock gate for testnet Ondo-style stock pairs (contracts/evm/testnet/ElpidaTestOndoStock.sol and
// ElpidaTestStockFeed.sol). Pure; used by the token page, the token insights and the wallet.
//
// It mirrors the rules in packages/core/tokenized-equity.mjs (referencePriceStatus, checkGraduation 'on-completion'):
// trading on a curve does not depend on the stock price, but the buy that completes the curve, which graduates it
// into a DEX pool in the same transaction, needs a usable total-return price. On testnet there is no independent
// stock/USD pool, so the gate is the reference only; mainnet adds the pool TWAP and execution checks of
// packages/core/ondo-market.mjs. A paused stock halts every transfer, so every action waits for the issuer.

/** Chainlink's Ondo feeds have a 24 h heartbeat; testnets allow two days so a weekend does not stall them. */
export const TEST_STOCK_MAX_AGE_SEC = 2 * 86_400;
/** Block timestamps can run a little ahead of this computer's clock; beyond this a round counts as future-dated. */
export const TEST_STOCK_MAX_SKEW_SEC = 300;
export const MARKET_STATUS = ['open', 'closed', 'corporate-action'];
/** Display name for test stocks that imitate Ondo's issuer controls (`stockProvider() == "ondo-test"`). */
export const TEST_STOCK_PROVIDERS = { 'ondo-test': 'Ondo (test stand-in)' };

/**
 * `stock` is the indexed record: { provider, paused, price, updatedAt, marketStatus }. Returns
 * { status, usable, reason, age } where status is fresh | market-closed | stale | corporate-action | paused | outage.
 */
export function testStockStatus(stock, now = Math.floor(Date.now() / 1000), maxAgeSec = TEST_STOCK_MAX_AGE_SEC) {
  if (!stock) return null;
  const price = Number(stock.price), updatedAt = Number(stock.updatedAt), skewed = now - updatedAt, age = skewed < 0 && skewed >= -TEST_STOCK_MAX_SKEW_SEC ? 0 : skewed;
  if (stock.paused) return { status: 'paused', usable: false, age, reason: 'The issuer has paused this stock. Every transfer of it reverts, so trading, graduation and claims in it wait until the pause is lifted.' };
  if (stock.marketStatus === 'corporate-action') return { status: 'corporate-action', usable: false, age, reason: 'A corporate action is in progress. The stock price is frozen, so graduation waits until it settles. Curve trading continues.' };
  if (!(price > 0) || !Number.isFinite(updatedAt) || age < 0) return { status: 'outage', usable: false, age: null, reason: 'No valid stock price from the feed. Graduation waits for one.' };
  if (age > maxAgeSec) return stock.marketStatus === 'closed'
    ? { status: 'market-closed', usable: false, age, reason: 'The market is closed and the last stock price is too old. Graduation waits for a fresh price.' }
    : { status: 'stale', usable: false, age, reason: 'The stock price is older than the feed allows. Graduation waits for a fresh price.' };
  return { status: 'fresh', usable: true, age, reason: null };
}

/**
 * Why an action must wait, or null. `completes` marks a buy that would complete (and graduate) the curve;
 * `blocked` is whether the acting wallet is on the issuer's blocklist.
 */
export function testStockHold(stock, { action, completes = false, blocked = false } = {}, now) {
  const s = testStockStatus(stock, now);
  if (!s) return null;
  if (s.status === 'paused') return s.reason;
  if (blocked) return 'Your wallet is on this stock issuer\'s blocklist, so it cannot send or receive the stock. Nothing was sent.';
  if (action === 'buy' && completes && !s.usable) return `This buy would complete the curve and graduate it, but ${s.reason.charAt(0).toLowerCase()}${s.reason.slice(1)} Buy a little less, or try again later.`;
  return null;
}
