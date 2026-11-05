// Amounts for seeding the program's devnet SOL/stock conversion pool (scripts/seed-solana-conversion.mjs). The stock
// amount is set so the pool's price equals `stockUsd` at the current SOL/USD. Test networks only, at most 10 SOL.
export const MAX_SEED_SOL = 10;

export function conversionSeedPlan({ sol, solUsd, stockUsd, decimals }) {
  const solNumber = Number(sol), usd = Number(stockUsd), solPrice = Number(solUsd);
  if (!(solNumber > 0 && solNumber <= MAX_SEED_SOL)) throw new Error(`Seed between 0 and ${MAX_SEED_SOL} SOL.`);
  if (!(usd > 0 && Number.isFinite(usd))) throw new Error('--stock-usd must be a positive price.');
  if (!(solPrice > 0 && Number.isFinite(solPrice))) throw new Error('SOL/USD must be positive.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error('Unexpected stock decimals.');
  const solAmount = BigInt(Math.round(solNumber * 1e9));
  // stock units = SOL × SOL/USD ÷ stock/USD, in the stock's base units (micro-dollar precision on both prices).
  const stockAmount = solAmount * BigInt(Math.round(solPrice * 1e6)) * 10n ** BigInt(decimals) / (BigInt(Math.round(usd * 1e6)) * 1_000_000_000n);
  if (stockAmount <= 0n) throw new Error('Seed amount too small.');
  return { solAmount, stockAmount, solPerStock: usd / solPrice };
}
