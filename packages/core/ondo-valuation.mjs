import { normalizeAddress } from './tokenized-equity.mjs';

const integer = value => typeof value === 'bigint' ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

/** Pure valuation gate, not permission to launch/trade. No feed policy is installed by this module. */
export function valueOndoReserve({ asset, balanceRaw, reference, twap, policy, now }) {
  const reject = reason => ({ usable: false, reason });
  if (!asset || asset.provider !== 'ondo' || !['ethereum', 'bnb', 'solana'].includes(asset.network) || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) return reject('Unsupported asset identity or decimals.');
  const token = normalizeAddress(asset.network, asset.address);
  if (!token || !policy || typeof policy.verificationId !== 'string' || !policy.verificationId.trim() || typeof policy.feedId !== 'string' || !policy.feedId.trim() || policy.network !== asset.network || normalizeAddress(asset.network, policy.token) !== token || !normalizeAddress(asset.network, policy.pool)) return reject('A reviewed policy for this exact chain, token and pool is required.');
  if (!positiveInt(policy.maxAgeSec) || !positiveInt(policy.minTwapWindowSec) || !Number.isInteger(policy.maxDivergenceBps) || policy.maxDivergenceBps < 0 || policy.maxDivergenceBps > 10000 || !Number.isSafeInteger(now) || now < 0) return reject('Invalid freshness, TWAP or divergence policy.');
  const sameToken = quote => quote?.network === asset.network && normalizeAddress(asset.network, quote.token) === token;
  if (!sameToken(reference) || !sameToken(twap) || reference.feedId !== policy.feedId || normalizeAddress(asset.network, twap.pool) !== normalizeAddress(asset.network, policy.pool)) return reject('Price identity does not match the approved feed, token and pool.');
  if (reference.currency !== 'USD' || twap.currency !== 'USD' || reference.basis !== 'per-raw-token' || twap.basis !== 'per-raw-token') return reject('Both prices must be USD per raw token; underlying-share or display-unit prices are refused.');
  const fresh = timestamp => Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now && now - timestamp <= policy.maxAgeSec;
  if (!fresh(reference.updatedAt) || !fresh(twap.updatedAt) || !fresh(reference.statusUpdatedAt)) return reject('Price or asset-status timestamp is missing, stale or in the future.');
  if (reference.assetStatus !== 'tradable' || reference.corporateAction !== 'none') return reject('Asset trading or corporate-action status is not cleared.');
  if (!positiveInt(twap.windowSec) || twap.windowSec < policy.minTwapWindowSec) return reject('Pool TWAP history is too short or unknown.');
  const balance = integer(balanceRaw), ref = integer(reference.priceUsdWad), pool = integer(twap.priceUsdWad);
  if (balance == null || balance < 0n || ref == null || ref <= 0n || pool == null || pool <= 0n) return reject('Raw balances and WAD prices must be exact non-negative integers; prices must be positive.');
  const difference = ref > pool ? ref - pool : pool - ref;
  if (difference * 10000n > ref * BigInt(policy.maxDivergenceBps)) return reject('Stock-token reference and pool TWAP diverge beyond policy.');
  const priceUsdWad = ref < pool ? ref : pool;
  // A total-return token price already embeds shares-per-token changes. Never multiply again.
  return { usable: true, basis: 'per-raw-token', priceUsdWad, valueUsdWad: balance * priceUsdWad / (10n ** BigInt(asset.decimals)), verificationId: policy.verificationId };
}
