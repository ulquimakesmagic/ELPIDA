// Audit finding F-1 (docs/AUDIT_SCOPE.md). Anyone can create a token's DEX pool before the token graduates. A narrow
// band of cheap tokens placed in that pool just below the graduation price can absorb the migration adapter's 2%
// repricing budget, so the buy that completes the curve reverts with "pool price mismatch". Nothing is lost, and the
// curve keeps trading. The fix the app applies: buy those cheaper tokens off the pool first, never above the
// graduation price, then complete. The buyer receives the tokens at or below the curve's own price.

/** Integer square root (floor) for non-negative bigints. */
export function isqrt(n) {
  if (n < 0n) throw new Error('negative');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) + 1n;
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) break; x = y; }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/**
 * The pool price the adapter will require at graduation, as a v3 sqrtPriceX96. It mirrors ElpidaDexCurve._graduate:
 * the real reserve at the sale cap (q) plus the locked bonus (B) is matched against q * (vT - cap) / (vQ + q)
 * tokens, so the price in quote per token is (q + B)(vQ + q) / (q (vT - cap)).
 */
export function graduationSqrtPriceX96({ virtualQuote: vQ, virtualToken: vT, saleCap, liquidityBonus = 0n, tokenIsToken0 }) {
  const rest = vT - saleCap, q = vQ * vT / rest - vQ;
  const num = (q + liquidityBonus) * (vQ + q), den = q * rest;
  return tokenIsToken0 ? isqrt((num << 192n) / den) : isqrt((den << 192n) / num);
}

/** True when the completing buy failed because a pre-created pool could not be repriced. */
export function blockedByPool(error) {
  const text = [error?.reason, error?.shortMessage, error?.message, error?.info?.error?.message].filter(Boolean).join(' ');
  return /pool price mismatch/.test(text);
}

/** The token is cheaper in the pool than at graduation (the band the app can buy out). */
export function tokenCheaperInPool({ poolSqrtPriceX96, graduationSqrtPriceX96, tokenIsToken0 }) {
  return tokenIsToken0 ? poolSqrtPriceX96 < graduationSqrtPriceX96 : poolSqrtPriceX96 > graduationSqrtPriceX96;
}
