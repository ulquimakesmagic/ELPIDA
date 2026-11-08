// ELPIDA V2.0 reference economics (docs/V2_0_AUDIT.md). Browser-safe: plain BigInt, no imports.
// Reference math only: no contract uses these values yet. Contracts, indexer and UI must match this module, and its
// tests are the spec's acceptance checks for launch economics, fees, the first-buy cap and the five-way split.

/** Approved V2.0 parameters (spec §4). Amounts in USD micro-units (6 decimals) where they are money. */
export const V2 = Object.freeze({
  launchFeeUsdE6: 10_000_000n,          // $10
  startFdvUsdE6: 20_000_000_000n,       // $20,000
  graduationFdvUsdE6: 100_000_000_000n, // $100,000
  tokenSupply: 1_000_000_000n * 10n ** 18n,
  defaultFeeBps: 125,                   // 1.25%
  maxFeeBps: 400,                       // 4.00%
  firstBuyCapBps: 300,                  // 3% of total supply
  tickerPattern: /^[A-Za-z0-9]{1,10}$/,
});

/**
 * Minimum creator-selectable fee. NOT an approved parameter (spec §25.1): kept configurable and passed in by callers.
 * The audit recommends 100 bps; this default only exists so tests and previews have a value.
 */
export const V2_PROPOSED_MIN_FEE_BPS = 100;

/** Five-way split of collected trading fees, in basis points of the whole fee (spec §11). Sums to 10,000. */
export const V2_FEE_SPLIT = Object.freeze({ creator: 3_000, traderAirdrop: 3_000, flywheel: 1_000, holderRewards: 1_000, treasury: 2_000 });
const BPS = 10_000n;

/** Graduation price multiple r = graduation FDV / start FDV (×5 under V2). */
export function priceMultiple({ startFdv = V2.startFdvUsdE6, graduationFdv = V2.graduationFdvUsdE6 } = {}) {
  if (startFdv <= 0n || graduationFdv <= startFdv) throw new Error('Graduation must be above the start.');
  if (graduationFdv % startFdv) throw new Error('V2 uses a whole price multiple.');
  return graduationFdv / startFdv;
}

/**
 * Virtual token reserve for a constant-product curve that graduates at r× the start price with price continuity into a
 * pool holding the unsold supply and all quote raised: vT = r·S / (r − 1). Floors like the deployed contracts.
 * Under V2 (r = 5) this is exactly 1.25 × supply.
 */
export function virtualToken({ supply = V2.tokenSupply, multiple = priceMultiple() } = {}) {
  if (multiple <= 1n) throw new Error('Multiple must exceed 1.');
  return multiple * supply / (multiple - 1n);
}

/** Virtual quote for a start FDV, given the quote's USD price (micro-USD per whole quote unit) and decimals. */
export function virtualQuote({ startFdvUsdE6 = V2.startFdvUsdE6, quoteUsdE6, quoteDecimals, supply = V2.tokenSupply, vT = virtualToken() }) {
  if (typeof quoteUsdE6 !== 'bigint' || quoteUsdE6 <= 0n || !Number.isInteger(quoteDecimals) || quoteDecimals < 0) throw new Error('Invalid quote price.');
  // start price per token (quote units) = startFdv / supply; vQ = price · vT.
  return startFdvUsdE6 * vT * 10n ** BigInt(quoteDecimals) / (quoteUsdE6 * supply);
}

/** Tokens the curve sells before graduation: vT · (1 − 1/√r), floored. */
export function saleTokens({ vT = virtualToken(), multiple = priceMultiple() } = {}) {
  const E18 = 10n ** 18n;
  return vT - vT * E18 / isqrt(multiple * E18 * E18);
}

/** Validates a creator-selected fee. `minBps` is required until the minimum is approved. */
export function validateFeeBps(feeBps, { minBps }) {
  if (!Number.isInteger(minBps) || minBps < 1 || minBps > V2.defaultFeeBps) throw new Error('Minimum fee must be set and at most the default.');
  if (!Number.isInteger(feeBps)) throw new Error('Fee must be whole basis points.');
  if (feeBps < minBps) throw new Error(`Fee below the ${minBps} bps minimum.`);
  if (feeBps > V2.maxFeeBps) throw new Error('Fee above the 4% maximum.');
  return feeBps;
}

/** Fee on a gross amount, floored (the payer keeps the dust), as every Elpida curve does. */
export function feeOn(gross, feeBps) {
  if (typeof gross !== 'bigint' || gross < 0n) throw new Error('Invalid amount.');
  return gross * BigInt(feeBps) / BPS;
}

/**
 * Splits a collected fee five ways. Four shares are floored; the treasury takes the remainder, so the parts always sum
 * to the fee exactly and no share is ever credited more than its basis points.
 */
export function splitFee(fee, split = V2_FEE_SPLIT) {
  if (typeof fee !== 'bigint' || fee < 0n) throw new Error('Invalid fee.');
  const total = Object.values(split).reduce((s, v) => s + v, 0);
  if (total !== 10_000 || Object.values(split).some(v => !Number.isInteger(v) || v < 0)) throw new Error('Split must total 10,000 bps.');
  const creator = fee * BigInt(split.creator) / BPS;
  const traderAirdrop = fee * BigInt(split.traderAirdrop) / BPS;
  const flywheel = fee * BigInt(split.flywheel) / BPS;
  const holderRewards = fee * BigInt(split.holderRewards) / BPS;
  return { creator, traderAirdrop, flywheel, holderRewards, treasury: fee - creator - traderAirdrop - flywheel - holderRewards };
}

/** The most tokens a developer first buy may receive: 3% of total supply. */
export function firstBuyCapTokens(supply = V2.tokenSupply) {
  return supply * BigInt(V2.firstBuyCapBps) / BPS;
}

/**
 * Quotes a first buy against a fresh curve and enforces the cap on tokens received. Zero is valid (no first buy).
 * Returns the gross quote needed for exactly `tokens` (fee included, rounded up) when asked by tokens.
 */
export function quoteFirstBuy({ gross, feeBps, vQ, vT = virtualToken(), supply = V2.tokenSupply }) {
  if (gross === 0n) return { gross: 0n, fee: 0n, tokens: 0n };
  if (typeof gross !== 'bigint' || gross < 0n) throw new Error('Invalid first buy.');
  const fee = feeOn(gross, feeBps), net = gross - fee;
  const tokens = vT * net / (vQ + net);
  if (tokens > firstBuyCapTokens(supply)) throw new Error('First buy above 3% of supply.');
  return { gross, fee, tokens };
}

/** The largest gross first buy that stays within the cap (fee included). */
export function maxFirstBuyGross({ feeBps, vQ, vT = virtualToken(), supply = V2.tokenSupply }) {
  const cap = firstBuyCapTokens(supply);
  // net needed for exactly `cap` tokens: vQ·cap / (vT − cap), floored so the result never exceeds the cap.
  const net = vQ * cap / (vT - cap);
  // gross such that gross − floor(gross·fee) ≤ net; start from net·BPS/(BPS − fee) and walk down.
  let gross = net * BPS / (BPS - BigInt(feeBps));
  while (gross > 0n && gross - feeOn(gross, feeBps) > net) gross--;
  while (gross - feeOn(gross + 1n, feeBps) + 1n <= net) gross++;
  return gross;
}

/** Ticker rule (spec §6.2). Tickers are not unique: this is format only. */
export function isValidTicker(ticker) {
  return typeof ticker === 'string' && V2.tickerPattern.test(ticker);
}

/** Smallest multiple of `spacing` ticks whose price ratio 1.0001^t reaches `multiple` (never cheaper than ×r). */
export function saleTicks(multiple = Number(priceMultiple()), spacing = 10) {
  let t = Math.ceil(Math.log(multiple) / Math.log(1.0001) / spacing) * spacing;
  while (Math.pow(1.0001, t - spacing) >= multiple) t -= spacing;
  while (Math.pow(1.0001, t) < multiple) t += spacing;
  return t;
}

function isqrt(n) {
  if (n < 0n) throw new Error('Negative.');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
