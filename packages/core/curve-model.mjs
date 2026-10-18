// One source of truth for the launch curve shape, shared by the server, the indexer, tests and the browser
// (served at /curve-model.mjs). Browser-safe: no Node imports.
//
// Model 10 (EVM) and the Solana program use the same curve: virtual tokens = 1B x 10/9 and a sale cap of
// 1B x sqrt(10)/(sqrt(10)+1), so the price ends at exactly 10x the start and the unsold supply matches the
// terminal price at graduation. Values are the Solana program's 6-decimal amounts, scaled to 18 decimals on EVM.

export const DEX_MODEL = 'curve-dex-v10';
export const LEGACY_DEX_MODEL = 'curve-dex-v9';
export const BETA_MODEL = 'curve-beta-v8';
export const TAX_MODEL = 'curve-tax-v10';
export const MODEL_VERSIONS = Object.freeze({ [DEX_MODEL]: 10, [LEGACY_DEX_MODEL]: 9, [BETA_MODEL]: 8, [TAX_MODEL]:10 });
/** Models backed by ElpidaDexFactory / ElpidaDexCurve ABIs (Uniswap v3 graduation). */
export const isDexModel = model => model === DEX_MODEL || model === LEGACY_DEX_MODEL;

export const TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const VIRTUAL_TOKEN = 1_111_111_111_111_111n * 10n ** 12n;
export const SALE_CAP = 759_746_926_647_958n * 10n ** 12n;
export const END_MULTIPLE = 10;

export const BASE_FEE_BPS = 125;
export const SNIPE_START_BPS = 9000;
export const SNIPE_WINDOW_SECONDS = 60;
export const GRADUATION_GRACE_SECONDS = 24 * 60 * 60;

/** Starting FDV in whole US dollars. Mainnet is always $5,000; public testnets are test-sized at $50. */
export const MAINNET_START_FDV_USD = 5000;
export const TESTNET_START_FDV_USD = 50;
/** The local simulator uses full-size numbers with simulated funds. */
export const LOCAL_START_FDV_USD = 5000;

/** Whole-unit curve shapes for display and previews (never for settlement). */
const SHAPES = Object.freeze({
  [DEX_MODEL]: { virtualTokens: 1_111_111_111.111111, saleCap: 759_746_926.647958, virtualFactor: 10 / 9, endMultiple: 10 },
  [LEGACY_DEX_MODEL]: { virtualTokens: 1_066_666_666.6667, saleCap: 800_000_000, virtualFactor: 16 / 15, endMultiple: 16 },
  [BETA_MODEL]: { virtualTokens: 1_066_666_666.6667, saleCap: 800_000_000, virtualFactor: 16 / 15, endMultiple: 16 },
});
export function curveShape(model = DEX_MODEL) {
  const shape = SHAPES[model];
  if (!shape) throw new Error(`Unknown curve model ${model}.`);
  return shape;
}

/** Starting FDV to enforce for a network: $5,000 on any mainnet, $50 on testnets. */
export function startFdvUsdFor(net) { return net?.mainnet ? MAINNET_START_FDV_USD : TESTNET_START_FDV_USD; }
/** Deploy tooling guard: a mainnet factory must start at $5,000 and use the 24 h graduation grace. */
export function assertDeploymentTerms(net, { startFdvUsd, graduationGrace }) {
  const start = Number(startFdvUsd), grace = Number(graduationGrace);
  if (!Number.isSafeInteger(start) || start < 1) throw new Error('Starting FDV must be a whole number of US dollars.');
  if (!Number.isSafeInteger(grace) || grace < 60) throw new Error('Graduation grace must be at least 60 seconds.');
  if (net?.mainnet && start !== MAINNET_START_FDV_USD) throw new Error(`Mainnet launchpads must start at $${MAINNET_START_FDV_USD} FDV, not $${start}.`);
  if (net?.mainnet && grace !== GRADUATION_GRACE_SECONDS) throw new Error('Mainnet launchpads must use the 24 hour graduation grace.');
  return { startFdvUsd: start, graduationGrace: grace };
}

/** Virtual reserve (raw units) for an approved stable quote such as USDC: start FDV x 10/9, rounded up. */
export function usdQuoteTemplate(startFdvUsd, decimals) {
  const n = BigInt(startFdvUsd) * 10n ** BigInt(decimals) * 10n;
  return (n + 8n) / 9n;
}
/** Starting FDV implied by a curve's virtual quote reserve (raw units of the quote asset). */
export function startFdvFromVirtualQuote(virtualQuote, kind = 'dex') {
  const v = BigInt(virtualQuote);
  return kind === 'dex' ? v * 9n / 10n : v * 15n / 16n;
}

/** Mirrors ElpidaDexCurve.currentFeeBps and the Solana program's current_fee_bps (times in seconds). */
export function currentFeeBps(launchedAt, now, { base = BASE_FEE_BPS, start = SNIPE_START_BPS, window = SNIPE_WINDOW_SECONDS } = {}) {
  const elapsed = Math.max(0, Math.floor(Number(now) - Number(launchedAt)));
  if (!window || elapsed >= window) return base;
  return base + Math.floor((start - base) * (window - elapsed) / window);
}
/** Seconds left in the anti-snipe window (0 once the fee has settled at the base rate). */
export function snipeSecondsLeft(launchedAt, now, window = SNIPE_WINDOW_SECONDS) {
  return Math.max(0, Number(launchedAt) + window - Math.floor(Number(now)));
}
/** "Launch fee window: 47% -> 1.25% in 31 s", or null once the window has passed. */
export function snipeLabel(launchedAt, now, opts = {}) {
  const left = snipeSecondsLeft(launchedAt, now, opts.window);
  if (!left) return null;
  const pct = bps => `${Number((bps / 100).toFixed(2))}%`;
  return `Launch fee window: ${pct(currentFeeBps(launchedAt, now, opts))} → ${pct(opts.base ?? BASE_FEE_BPS)} in ${left} s`;
}

/** Share of total supply as a percentage with two decimals, from raw 18-decimal balances. */
export function supplyPercent(raw, supply = TOKEN_SUPPLY) {
  const value = BigInt(raw ?? 0);
  if (value <= 0n || BigInt(supply) <= 0n) return 0;
  return Number(value * 1_000_000n / BigInt(supply)) / 10_000;
}
/** "Dev bought 4.2% at launch · holds 3.1% now" */
export function devLabel(boughtPct, holdsPct) {
  if (boughtPct == null) return null;
  const pct = n => `${Number(Number(n).toFixed(2))}%`;
  return holdsPct == null ? `Dev bought ${pct(boughtPct)} at launch` : `Dev bought ${pct(boughtPct)} at launch · holds ${pct(holdsPct)} now`;
}
