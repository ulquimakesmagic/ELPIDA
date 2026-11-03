// Per-stock approval on a mainnet launchpad (3 November 2026). Approving a real tokenized stock as a trading pair is
// done only from the operator panel (#/monkey?tab=pairs) and only when the verified registry
// (config/tokenized-equity-registry.json) says the stock may be a launch quote reserve AND a graduated pool asset,
// and records the production price feed it is valued with. The starting valuation is fixed at approval: the
// launchpad's starting FDV in USD, converted to stock units at the feed price.
import { usdQuoteTemplate } from '/curve-model.mjs';

/** Why `record` (from /api/public/tokenized-equity) must not be approved, or null when every gate passes. */
export function stockApprovalGate(record, { mainnet = false } = {}) {
  if (!mainnet) return 'Real tokenized stocks exist only on mainnet. On testnets, add the labelled stand-ins with Add test pair.';
  if (!record) return 'This stock is not in the verified registry for this network. Tickers and look-alike tokens are never accepted.';
  for (const key of ['launchQuote', 'graduatedPool']) {
    const state = record.capabilities?.[key];
    if (!state?.enabled) return state?.reason ?? `${key} is not verified for ${record.symbol}.`;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(record.feed ?? ''))) return `No production price feed is recorded for ${record.symbol}.`;
  return null;
}

/**
 * The virtual quote reserve for a stock whose USD price is `priceUsd8` (8 decimals): the USD template for a $1 asset
 * with the stock's decimals, divided by the price. Refuses prices outside $0.01 to $1,000,000 as a unit mistake.
 */
export function stockVirtualQuote({ startFdvUsd, decimals, priceUsd8 }) {
  const price = BigInt(priceUsd8);
  if (price < 10n ** 6n || price > 10n ** 14n) throw new Error('The stock price is outside $0.01 to $1,000,000. Check the feed before approving.');
  const vq = usdQuoteTemplate(startFdvUsd, decimals) * 10n ** 8n / price;
  if (vq <= 0n) throw new Error('The starting valuation rounds to zero.');
  return vq;
}

/** A price feed read is fresh when positive, complete and newer than `maxAge` seconds at `now` (seconds). */
export function freshFeedPrice([roundId, answer, , updatedAt, answeredInRound], decimals, { now, maxAge }) {
  if (answer <= 0n || roundId === 0n || answeredInRound < roundId || updatedAt <= 0n || BigInt(now) - updatedAt > BigInt(maxAge)) throw new Error('The stock price feed is stale or incomplete. Nothing was approved.');
  const d = Number(decimals);
  return d >= 8 ? answer / 10n ** BigInt(d - 8) : answer * 10n ** BigInt(8 - d);
}
