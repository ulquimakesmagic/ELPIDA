import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';

const address = value => /^0x[0-9a-f]{40}$/i.test(value ?? '') ? value.toLowerCase() : null;
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
const exact = value => typeof value === 'bigint' ? value : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const Q = 1n << 256n, ceil = (a, b) => (a + b - 1n) / b;

/** Interval arithmetic bounds 1.0001^tick without floating point or a copied TickMath implementation. */
export function tickRatioBounds(tick) {
  assert.ok(Number.isInteger(tick) && Math.abs(tick) <= 887272);
  let n = Math.abs(tick), low = Q, high = Q, baseLow = 10001n * Q / 10000n, baseHigh = ceil(10001n * Q, 10000n);
  while (n) {
    if (n % 2) { low = low * baseLow / Q; high = ceil(high * baseHigh, Q); }
    n = Math.floor(n / 2);
    if (n) { baseLow = baseLow * baseLow / Q; baseHigh = ceil(baseHigh * baseHigh, Q); }
  }
  return tick < 0 ? { low: Q * Q / high, high: ceil(Q * Q, low), scale: Q } : { low, high, scale: Q };
}

/** Matches V3's signed tick floor and wrapping accumulators; policy must separately reject thin history. */
export function consultV3({ ticks, secondsPerLiquidity, windowSec }) {
  assert.ok(Number.isInteger(windowSec) && windowSec > 0 && windowSec <= 0xffffffff);
  assert.equal(ticks.length, 2); assert.equal(secondsPerLiquidity.length, 2);
  const delta = BigInt.asIntN(56, BigInt(ticks[1]) - BigInt(ticks[0])), seconds = BigInt(windowSec);
  const floorTick = delta / seconds - (delta < 0n && delta % seconds !== 0n ? 1n : 0n);
  const ceilTick = delta / seconds + (delta > 0n && delta % seconds !== 0n ? 1n : 0n);
  assert.ok(floorTick >= -887272n && ceilTick <= 887272n);
  const liquidityDelta = BigInt.asUintN(160, BigInt(secondsPerLiquidity[1]) - BigInt(secondsPerLiquidity[0]));
  assert.ok(liquidityDelta > 0n);
  return { floorTick: Number(floorTick), ceilTick: Number(ceilTick), harmonicMeanLiquidity: seconds * ((1n << 160n) - 1n) / (liquidityDelta << 32n) };
}

const abi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)',
  'function decimals() view returns(uint8)',
  'function fee() view returns(uint24)', 'function factory() view returns(address)', 'function getPool(address,address,uint24) view returns(address)',
  'function observe(uint32[]) view returns(int56[],uint160[])']);

/** Read observations from a reviewed canonical V3 pool. No spot fallback, feed discovery or live approval. */
export async function readOndoV3Twap({ asset, policy, snapshot, quoteUsd, request }) {
  assert.ok(asset?.provider === 'ondo' && ['ethereum', 'bnb'].includes(asset.network));
  assert.equal(snapshot.chainId, ({ ethereum: 1, bnb: 56 })[asset.network]);
  assert.equal(policy.network, asset.network);
  assert.ok(address(asset.address) && address(policy.token) === address(asset.address));
  assert.ok(address(policy.quoteToken) && address(policy.quoteToken) !== address(asset.address));
  assert.ok(Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 18);
  assert.ok(Number.isInteger(policy.quoteDecimals) && policy.quoteDecimals >= 0 && policy.quoteDecimals <= 18);
  assert.ok(Number.isInteger(policy.minTwapWindowSec) && policy.minTwapWindowSec > 0 && policy.minTwapWindowSec <= 0xffffffff);
  const minimum = exact(policy.minHarmonicLiquidity); assert.ok(minimum != null && minimum > 0n);
  assert.ok(Number.isSafeInteger(snapshot.number) && snapshot.number > 0 && hash(snapshot.hash));
  assert.equal(Number(BigInt(await request('eth_chainId', []))), snapshot.chainId);
  const header = await request('eth_getBlockByHash', [snapshot.hash, false]);
  assert.ok(header && header.hash.toLowerCase() === snapshot.hash.toLowerCase() && Number(BigInt(header.number)) === snapshot.number);
  const timestamp = Number(BigInt(header.timestamp)); assert.ok(Number.isSafeInteger(timestamp) && timestamp >= 0);
  const quotePrice = exact(quoteUsd?.priceUsdWad);
  assert.ok(quotePrice != null && quotePrice > 0n && quoteUsd.network === asset.network && address(quoteUsd.token) === address(policy.quoteToken));
  assert.ok(typeof policy.quoteFeedId === 'string' && policy.quoteFeedId.trim() && quoteUsd.feedId === policy.quoteFeedId);
  assert.ok(quoteUsd.basis === 'per-raw-token' && quoteUsd.currency === 'USD' && quoteUsd.blockNumber === snapshot.number && quoteUsd.blockHash?.toLowerCase() === snapshot.hash.toLowerCase());
  assert.ok(Number.isSafeInteger(policy.maxAgeSec) && policy.maxAgeSec > 0 && Number.isSafeInteger(quoteUsd.updatedAt)
    && quoteUsd.updatedAt >= 0 && quoteUsd.updatedAt <= timestamp && timestamp - quoteUsd.updatedAt <= policy.maxAgeSec);
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  for (const name of ['pool', 'factory']) {
    assert.ok(address(policy[name]) && hash(policy[name + 'CodeHash']));
    assert.equal(keccak256(await request('eth_getCode', [policy[name], block])), policy[name + 'CodeHash'].toLowerCase());
  }
  const call = async (to, name, args = []) => abi.decodeFunctionResult(name, await request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, block]));
  const [token0] = await call(policy.pool, 'token0'), [token1] = await call(policy.pool, 'token1');
  assert.deepEqual([address(token0), address(token1)].sort(), [address(asset.address), address(policy.quoteToken)].sort());
  assert.equal(Number((await call(asset.address, 'decimals'))[0]), asset.decimals);
  assert.equal(Number((await call(policy.quoteToken, 'decimals'))[0]), policy.quoteDecimals);
  assert.ok(Number.isInteger(policy.fee) && policy.fee > 0 && policy.fee < 1000000);
  assert.equal(Number((await call(policy.pool, 'fee'))[0]), policy.fee);
  assert.equal(address((await call(policy.pool, 'factory'))[0]), address(policy.factory));
  assert.equal(address((await call(policy.factory, 'getPool', [token0, token1, policy.fee]))[0]), address(policy.pool));
  const [ticks, secondsPerLiquidity] = await call(policy.pool, 'observe', [[policy.minTwapWindowSec, 0]]);
  const result = consultV3({ ticks, secondsPerLiquidity, windowSec: policy.minTwapWindowSec });
  assert.ok(result.harmonicMeanLiquidity >= minimum, 'historical active liquidity is below policy');
  const tokenFirst = address(token0) === address(asset.address);
  // Lower bound for quote/token: floor tick when direct, ceil tick before inversion.
  const ratio = tickRatioBounds(tokenFirst ? result.floorTick : result.ceilTick);
  const numerator = tokenFirst ? ratio.low : Q * Q / ratio.high;
  const priceUsdWad = numerator * (10n ** BigInt(asset.decimals)) * quotePrice / (Q * (10n ** BigInt(policy.quoteDecimals)));
  assert.ok(priceUsdWad > 0n);
  return { network: asset.network, token: asset.address, pool: policy.pool, currency: 'USD', basis: 'per-raw-token',
    priceUsdWad: priceUsdWad.toString(), updatedAt: timestamp, blockNumber: snapshot.number, blockHash: snapshot.hash,
    windowSec: policy.minTwapWindowSec, meanTick: result.floorTick, harmonicMeanLiquidity: result.harmonicMeanLiquidity.toString(),
    liveCapabilitiesApproved: false, note: 'Geometric tick-window price combined with a trusted quote-USD observation; not guaranteed execution or issuer approval.' };
}
