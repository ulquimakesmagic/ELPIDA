// Minimum holding for holder rewards. A creator can set a token amount, a USD value, or both.
// The USD value is converted to tokens when the epoch is built, at a fresh USD price, and the larger
// of the two requirements applies. The result is fixed in the epoch manifest, so later price moves
// do not change who qualified. Without a fresh price a USD minimum cannot be evaluated, so no epoch runs.
export const MAX_MINIMUM_USD = 100000;

/** Whole-token amount (as base units) worth at least `usd` at `tokenPriceUsd`. Rounds up so nobody qualifies below the target. */
export function minimumHoldingFromUsd({ usd, tokenPriceUsd, decimals = 18 }) {
  const u = Number(usd);
  if (!(u >= 0) || u > MAX_MINIMUM_USD) throw new Error('The USD minimum is out of range.');
  if (u === 0) return 0n;
  if (!(Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0)) throw new Error('A fresh USD price is required to apply a USD minimum.');
  // Work in micro-USD and 1e-12 price units to avoid float rounding on large token counts.
  const microUsd = BigInt(Math.round(u * 1e6)), micro = BigInt(Math.round(tokenPriceUsd * 1e12));
  if (micro === 0n) throw new Error('The token price is too small to convert a USD minimum.');
  const scale = 10n ** BigInt(decimals);
  return (microUsd * 10n ** 6n * scale + micro - 1n) / micro;
}

/** The binding minimum: the larger of the token amount and the USD-derived amount. Null means no price, so wait. */
export function effectiveMinimum({ tokens, usd = '0', tokenPriceUsd = null, decimals = 18 }) {
  const t = BigInt(tokens);
  if (!(Number(usd) > 0)) return t;
  if (!(Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0)) return null;
  const fromUsd = minimumHoldingFromUsd({ usd, tokenPriceUsd, decimals });
  return fromUsd > t ? fromUsd : t;
}
