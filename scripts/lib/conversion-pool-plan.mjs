// Amounts and starting price for a full-range native/test-stock conversion pool (scripts/seed-conversion-pools.mjs).
// Prices are USD with 8 decimals; both tokens have 18 decimals. Test networks only: at most 1 native coin per pool.
export const MAX_SEED_NATIVE = 10n ** 18n;
const MAX_TICK = 887272;

export function sqrtInteger(n) { if (n < 0n) throw new Error('negative square root'); if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

export function conversionPoolPlan({ nativeAmount, nativeUsd8, stockUsd8, asset, weth, spacing, fee = 10000 }) {
  if (nativeAmount <= 0n || nativeAmount > MAX_SEED_NATIVE) throw new Error('Seed between 0 and 1 native coin per pool.');
  if (nativeUsd8 <= 0n || stockUsd8 <= 0n) throw new Error('Both prices must be positive.');
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('Invalid tick spacing.');
  const stockAmount = nativeAmount * nativeUsd8 / stockUsd8;
  if (stockAmount <= 0n) throw new Error('Seed amount too small.');
  const assetFirst = BigInt(asset) < BigInt(weth);
  const token0 = assetFirst ? asset : weth, token1 = assetFirst ? weth : asset;
  const amount0 = assetFirst ? stockAmount : nativeAmount, amount1 = assetFirst ? nativeAmount : stockAmount;
  const tickUpper = Math.floor(MAX_TICK / spacing) * spacing;
  return { token0, token1, amount0, amount1, stockAmount, fee, tickLower: -tickUpper, tickUpper, sqrtPriceX96: sqrtInteger((amount1 << 192n) / amount0) };
}
