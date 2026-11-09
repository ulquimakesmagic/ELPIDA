// Model 11 (Uniswap v4 hook, liquidity locked from launch) shared by the indexer, the server, tests and the browser
// (served at /v4-model.mjs). Browser-safe: plain BigInt, no imports. The math mirrors Uniswap's TickMath and
// SqrtPriceMath and the hook's own launch sizing (contracts/evm/v4/ElpidaV4Hook.sol), so a page and the indexer read a
// launch's positions exactly as the chain holds them.

export const V4_MODEL = 'v4-hook-v11';
export const V4_MODEL_VERSION = 11;
export const V4_TICK_SPACING = 10;
export const V4_SALE_TICKS = 23_030;
export const V4_MIN_USABLE_TICK = -887_270;
export const V4_MAX_USABLE_TICK = 887_270;
/** Base fee, anti-snipe start and window, and the fee after the milestone (decision of 2 November 2026: 1%). */
export const V4_FEE = Object.freeze({ base: 125, start: 9000, window: 60, pool: 100 });
export const V4_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const V4_VIRTUAL_TOKEN = 1_111_111_111_111_111n * 10n ** 12n;
/** beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta. */
export const V4_HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
export const V4_FLAG_MASK = (1n << 14n) - 1n;
/**
 * The networks Model 11 may be deployed on: the Sepolias with Uniswap v4, and BNB Chain testnet with a labelled test copy
 * of Uniswap's PoolManager (Malik, 6 November 2026; BNB mainnet has Uniswap v4 itself). networks.mjs `v4` holds each.
 */
export const V4_NETWORKS = Object.freeze(['base-sepolia', 'ethereum-sepolia', 'bnb-testnet', 'robinhood-testnet']);

const Q96 = 1n << 96n, Q128 = 1n << 128n, MAX_UINT256 = (1n << 256n) - 1n;
const MIN_SQRT_PRICE = 4295128739n, MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const TICK_FACTORS = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];
const divUp = (a, b) => a / b + (a % b ? 1n : 0n);
const mulDivUp = (a, b, c) => divUp(a * b, c);
const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
/** One wei per tick-bitmap word in the sale range (23,030 ticks / (256 x 10) per word, plus both ends). */
const SWAP_WORD_MARGIN = BigInt(Math.ceil(V4_SALE_TICKS / (256 * V4_TICK_SPACING)) + 2);

/** TickMath.getSqrtPriceAtTick, exactly. */
export function sqrtPriceAtTick(tick) {
  const t = BigInt(tick), abs = t < 0n ? -t : t;
  if (abs > 887_272n) throw new Error('Tick out of range.');
  let price = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (let i = 0; i < TICK_FACTORS.length; i++) if (abs & (2n << BigInt(i))) price = price * TICK_FACTORS[i] >> 128n;
  if (t > 0n) price = MAX_UINT256 / price;
  return (price >> 32n) + (price % (1n << 32n) ? 1n : 0n);
}

/** TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is at most `sqrtPrice`. */
export function tickAtSqrtPrice(sqrtPrice) {
  const s = BigInt(sqrtPrice);
  if (s < MIN_SQRT_PRICE || s >= MAX_SQRT_PRICE) throw new Error('Price out of range.');
  const ratio = Number(s) / Number(Q96);
  let tick = Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
  tick = Math.max(-887_272, Math.min(887_271, tick));
  while (tick > -887_272 && sqrtPriceAtTick(tick) > s) tick--;
  while (tick < 887_271 && sqrtPriceAtTick(tick + 1) <= s) tick++;
  return tick;
}

/** SqrtPriceMath.getAmount0Delta: quote between two prices for liquidity `L`. */
export function amount0Delta(a, b, liquidity, roundUp = false) {
  let lo = BigInt(a), hi = BigInt(b); if (lo > hi) [lo, hi] = [hi, lo];
  const n1 = BigInt(liquidity) << 96n, n2 = hi - lo;
  return roundUp ? divUp(mulDivUp(n1, n2, hi), lo) : n1 * n2 / hi / lo;
}
/** SqrtPriceMath.getAmount1Delta: tokens between two prices for liquidity `L`. */
export function amount1Delta(a, b, liquidity, roundUp = false) {
  let lo = BigInt(a), hi = BigInt(b); if (lo > hi) [lo, hi] = [hi, lo];
  return roundUp ? mulDivUp(BigInt(liquidity), hi - lo, Q96) : BigInt(liquidity) * (hi - lo) / Q96;
}

/** Integer square root (the hook's _sqrt). */
function isqrt(x) { if (x === 0n) return 0n; let z = x, y = (x >> 1n) + 1n; while (y < z) { z = y; y = (x / y + y) >> 1n; } return z; }

/**
 * The positions the hook opens for a launch with `virtualQuote` (raw quote units), as ElpidaV4Hook.launch sizes them:
 * the sale range [lowerTick, upperTick] with liquidity `saleLiquidity` and [MIN_USABLE_TICK, lowerTick] with
 * `upperLiquidity`. The pool opens at upperTick's price.
 */
export function launchPositions(virtualQuote) {
  const vq = BigInt(virtualQuote);
  if (vq <= 0n) throw new Error('No virtual quote.');
  const start = isqrt(V4_VIRTUAL_TOKEN * Q96 / vq) << 48n;
  let upperTick = tickAtSqrtPrice(start);
  const rem = ((upperTick % V4_TICK_SPACING) + V4_TICK_SPACING) % V4_TICK_SPACING; upperTick -= rem;
  const lowerTick = upperTick - V4_SALE_TICKS;
  const sqrtU = sqrtPriceAtTick(upperTick), sqrtL = sqrtPriceAtTick(lowerTick), a = sqrtU - sqrtL;
  const b = a * (sqrtL - sqrtPriceAtTick(V4_MIN_USABLE_TICK)) / sqrtU;
  const saleLiquidity = (V4_TOKEN_SUPPLY - 8n) * Q96 / (a + b), upperLiquidity = saleLiquidity * a / sqrtU;
  return { upperTick, lowerTick, saleLiquidity, upperLiquidity, startSqrtPrice: sqrtU };
}

/** The fee the hook charges `elapsed` seconds after launch, in basis points (1% after the milestone). */
export function v4FeeBps(elapsed, graduated = false) {
  if (graduated) return V4_FEE.pool;
  const e = Math.max(0, Number(elapsed));
  if (e >= V4_FEE.window) return V4_FEE.base;
  return V4_FEE.base + Math.floor((V4_FEE.start - V4_FEE.base) * (V4_FEE.window - e) / V4_FEE.window);
}

/**
 * Tokens out for a creator's first buy of `gross` raw quote at launch (base fee only, as the hook charges it), for the
 * launch's minimum-out. Exact for a buy inside one tick-bitmap word, within a few wei beyond; a first buy past the milestone is not
 * offered by the site.
 */
export function firstBuyOut(virtualQuote, gross) {
  const g = BigInt(gross); if (g <= 0n) return 0n;
  const { saleLiquidity: L, startSqrtPrice: sqrtU, lowerTick } = launchPositions(virtualQuote);
  const net = g - g * BigInt(V4_FEE.base) / 10000n;
  // SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp, adding quote (price falls).
  const n1 = L << 96n, next = mulDivUp(n1, sqrtU, n1 + net * sqrtU);
  if (next < sqrtPriceAtTick(lowerTick)) throw new Error('This first buy would pass the milestone. Buy less at launch.');
  return amount1Delta(next, sqrtU, L, false);
}

/**
 * What a launch's pool holds and how far its sale has gone, from the hook's launch record and the pool's price.
 * `launch`: { upperTick, lowerTick, saleLiquidity, upperLiquidity, milestoneLiquidity, graduated }. Amounts are raw.
 * Only the hook's own positions count; liquidity third parties add after the treasury opens it is not included.
 */
export function v4PoolState(launch, sqrtPrice) {
  const p = BigInt(sqrtPrice), sqrtU = sqrtPriceAtTick(launch.upperTick), sqrtL = sqrtPriceAtTick(launch.lowerTick);
  const sqrtMin = sqrtPriceAtTick(V4_MIN_USABLE_TICK), sqrtMax = sqrtPriceAtTick(V4_MAX_USABLE_TICK);
  const positions = [[sqrtMin, sqrtL, BigInt(launch.upperLiquidity)], launch.graduated ? [sqrtL, sqrtMax, BigInt(launch.milestoneLiquidity)] : [sqrtL, sqrtU, BigInt(launch.saleLiquidity)]];
  let quote = 0n, tokens = 0n;
  for (const [a, b, liquidity] of positions) {
    if (!liquidity) continue;
    const at = clamp(p, a, b);
    quote += amount0Delta(at, b, liquidity); tokens += amount1Delta(a, at, liquidity);
  }
  const saleTokens = amount1Delta(sqrtL, sqrtU, launch.saleLiquidity);
  const saleRemaining = launch.graduated || p <= sqrtL ? 0n : amount1Delta(sqrtL, clamp(p, sqrtL, sqrtU), launch.saleLiquidity);
  // Quote still to be paid into the sale range before the milestone (net of fees). A v4 swap walks the tick bitmap one
  // 256-tick word at a time and rounds each step's input up, so it needs up to one wei more per word than the range's
  // single rounded total: SWAP_WORD_MARGIN covers the sale range's words.
  const toMilestone = launch.graduated || p <= sqrtL ? 0n : amount0Delta(sqrtL, clamp(p, sqrtL, sqrtU), launch.saleLiquidity, true) + SWAP_WORD_MARGIN;
  return { quoteReserve: quote, tokenReserve: tokens, saleTokens, saleRemaining, saleSold: saleTokens - saleRemaining, toMilestone };
}

/** Gross quote (fee included) that pays `net` into the pool at `bps`. */
export const grossForNet = (net, bps) => BigInt(net) === 0n ? 0n : divUp(BigInt(net) * 10000n, 10000n - BigInt(bps));

/** Quote per whole token, as a decimal string with 24 places, from a v4 sqrt price (quote is currency0). */
export function v4Price(sqrtPrice, quoteDecimals) {
  const s = BigInt(sqrtPrice); if (s === 0n) return null;
  const n = (1n << 192n) * 10n ** 18n * 10n ** 24n, d = s * s * 10n ** BigInt(quoteDecimals);
  const v = n / d, whole = v / 10n ** 24n, frac = (v % 10n ** 24n).toString().padStart(24, '0');
  return `${whole}.${frac}`;
}
