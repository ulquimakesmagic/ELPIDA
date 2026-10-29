import { normalizeAddress } from './tokenized-equity.mjs';
import { valueOndoReserve } from './ondo-valuation.mjs';

const integer = value => typeof value === 'bigint' ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');

/** Validate trusted, normalized market observations. No installed feed or authority to trade. */
export function validateOndoMarket(input) {
  const reject = reason => ({ usable: false, reason, liveCapabilitiesApproved: false });
  const valuation = valueOndoReserve(input);
  if (!valuation.usable) return reject(valuation.reason);
  const { asset, policy, reference, twap, liquidity, quoteUsd, now } = input;
  const address = a => normalizeAddress(asset.network, a);
  const quote = address(policy.quoteToken);
  if (!quote || quote === address(asset.address) || typeof policy.quoteFeedId !== 'string' || !policy.quoteFeedId.trim()
    || !Number.isInteger(policy.quoteDecimals) || policy.quoteDecimals < 0 || policy.quoteDecimals > 18
    || !positive(policy.maxSampleSkewSec) || !Number.isInteger(policy.maxExecutionLossBps)
    || policy.maxExecutionLossBps < 0 || policy.maxExecutionLossBps >= 10000) return reject('Reviewed quote identity, decimals, skew and execution-loss limits are required.');
  if (liquidity?.network !== asset.network || address(liquidity.token) !== address(asset.address)
    || address(liquidity.pool) !== address(policy.pool) || address(liquidity.quoteToken) !== quote
    || quoteUsd?.network !== asset.network || address(quoteUsd.token) !== quote || quoteUsd.feedId !== policy.quoteFeedId
    || quoteUsd.currency !== 'USD' || quoteUsd.basis !== 'per-raw-token') return reject('Executable liquidity or quote-USD identity does not match policy.');
  const samples = [twap, liquidity, quoteUsd];
  if (!samples.every(s => positive(s.blockNumber) && hash(s.blockHash))
    || !samples.every(s => s.blockNumber === twap.blockNumber && s.blockHash.toLowerCase() === twap.blockHash.toLowerCase())) return reject('Pool, execution and quote-USD observations must use the same canonical block.');
  const times = [reference.updatedAt, reference.statusUpdatedAt, ...samples.map(s => s.updatedAt)];
  if (!times.every(t => Number.isSafeInteger(t) && t >= 0 && t <= now && now - t <= policy.maxAgeSec)
    || Math.max(...times) - Math.min(...times) > policy.maxSampleSkewSec) return reject('Market observations are stale, future-dated or too far apart.');
  const balance = integer(input.balanceRaw), quotePrice = integer(quoteUsd.priceUsdWad);
  const sellIn = integer(liquidity.sell?.amountInRaw), sellOut = integer(liquidity.sell?.amountOutRaw);
  const buyIn = integer(liquidity.buy?.amountInRaw), buyOut = integer(liquidity.buy?.amountOutRaw);
  const minSell = integer(policy.minSellProbeRaw), buyProbe = integer(policy.buyProbeQuoteRaw), minDepth = integer(policy.minProbeUsdWad);
  if ([quotePrice, sellIn, sellOut, buyIn, buyOut, minSell, buyProbe, minDepth].some(v => v == null || v <= 0n)) return reject('Both executable directions and exact positive probe sizes/depth are required.');
  if (sellIn !== balance || sellIn < minSell || buyIn !== buyProbe) return reject('Sell probe must exactly match the reserve and meet minimum size; buy probe must match policy.');
  const tokenUnit = 10n ** BigInt(asset.decimals), quoteUnit = 10n ** BigInt(policy.quoteDecimals);
  const ref = integer(reference.priceUsdWad);
  // Keep all comparisons as cross-products: rounding must never admit a below-threshold quote.
  const loss = BigInt(policy.maxExecutionLossBps), retained = 10000n - loss;
  if (sellIn * ref < minDepth * tokenUnit || buyIn * quotePrice < minDepth * quoteUnit) return reject('Executable probe depth is below policy.');
  if (sellOut * quotePrice * tokenUnit * 10000n < sellIn * ref * quoteUnit * retained
    || buyOut * ref * quoteUnit * 10000n < buyIn * quotePrice * tokenUnit * retained) return reject('Executable buy/sell loss exceeds policy.');
  // This is a simulation observation, not a guaranteed fill or an executable transaction.
  const sellValueUsdWad = sellOut * quotePrice / quoteUnit;
  return { ...valuation, valueUsdWad: valuation.valueUsdWad < sellValueUsdWad ? valuation.valueUsdWad : sellValueUsdWad,
    executableSellProbeUsdWad: sellValueUsdWad, blockNumber: twap.blockNumber, blockHash: twap.blockHash,
    liveCapabilitiesApproved: false, note: 'Trusted input validation only; simulated quotes are not guaranteed fills or issuer eligibility.' };
}
