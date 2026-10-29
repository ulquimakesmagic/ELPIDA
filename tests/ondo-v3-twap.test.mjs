import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { tickRatioBounds, consultV3, readOndoV3Twap } from '../scripts/lib/ondo-v3-twap.mjs';
const Q = 1n << 256n;

test('fixed-point bounds contain exact positive/negative ratios without floating point', () => {
  for (const tick of [-100, -1, 0, 1, 100]) {
    const { low, high } = tickRatioBounds(tick), n = BigInt(Math.abs(tick));
    const num = tick < 0 ? 10000n ** n : 10001n ** n, den = tick < 0 ? 10001n ** n : 10000n ** n;
    assert.ok(low * den <= num * Q); assert.ok(high * den >= num * Q);
  }
  for (const tick of [-887272, 887272]) { const r = tickRatioBounds(tick); assert.ok(r.low > 0n && r.high >= r.low); }
  assert.throws(() => tickRatioBounds(887273));
});
test('consult floors negative fractional ticks and handles cumulative wrapping', () => {
  const r = consultV3({ ticks: [0n, -601n], secondsPerLiquidity: [0n, 600n << 100n], windowSec: 600 });
  assert.equal(r.floorTick, -2); assert.equal(r.ceilTick, -1);
  const wrapped = consultV3({ ticks: [(1n << 55n) - 100n, -(1n << 55n) + 500n], secondsPerLiquidity: [(1n << 160n) - 20n, 40n], windowSec: 600 });
  assert.equal(wrapped.floorTick, 1); assert.ok(wrapped.harmonicMeanLiquidity > 0n);
  assert.throws(() => consultV3({ ticks: [0n, 1n], secondsPerLiquidity: [0n, 0n], windowSec: 600 }));
});

const addr = n => '0x' + n.repeat(40), token = addr('1'), quote = addr('2'), pool = addr('3'), factory = addr('4'), hash = '0x' + '12'.repeat(32);
const abi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)',
  'function decimals() view returns(uint8)',
  'function factory() view returns(address)', 'function getPool(address,address,uint24) view returns(address)', 'function observe(uint32[]) view returns(int56[],uint160[])']);
const args = () => ({ asset: { provider: 'ondo', network: 'ethereum', address: token, decimals: 18 }, snapshot: { chainId: 1, number: 100, hash },
  policy: { network: 'ethereum', token, quoteToken: quote, pool, factory, poolCodeHash: keccak256('0x6000'), factoryCodeHash: keccak256('0x6000'), fee: 3000,
    quoteDecimals: 6, quoteFeedId: 'fixture-usd', maxAgeSec: 60, minTwapWindowSec: 600, minHarmonicLiquidity: '1000' },
  quoteUsd: { network: 'ethereum', token: quote, feedId: 'fixture-usd', blockNumber: 100, blockHash: hash, priceUsdWad: 10n ** 18n, updatedAt: 995, basis: 'per-raw-token', currency: 'USD' } });
const rpc = ({ inverse = false, fail = false, delta = 0n, tokenDecimals = 18 } = {}) => async (method, params) => {
  if (method === 'eth_chainId') return '0x1';
  if (method === 'eth_getBlockByHash') return { hash, number: '0x64', timestamp: '0x3e8' };
  assert.deepEqual(params.at(-1), { blockHash: hash, requireCanonical: true });
  if (method === 'eth_getCode') return '0x6000';
  assert.equal(method, 'eth_call'); const call = abi.parseTransaction({ data: params[0].data });
  if (call.name === 'decimals') return abi.encodeFunctionResult(call.fragment, [params[0].to === token ? tokenDecimals : 6]);
  if (call.name === 'observe') { if (fail) throw new Error('OLD'); assert.deepEqual(Array.from(call.args[0]), [600n, 0n]); return abi.encodeFunctionResult('observe', [[0n, delta], [0n, (600n << 128n) / 1000000n]]); }
  return abi.encodeFunctionResult(call.fragment, [{ token0: inverse ? quote : token, token1: inverse ? token : quote, fee: 3000, factory, getPool: pool }[call.name]]);
};
test('reader uses canonical cumulative observations, decimal scaling and conservative inverse rounding', async () => {
  const a = args();
  const direct = await readOndoV3Twap({ ...a, request: rpc() });
  assert.equal(direct.priceUsdWad, (10n ** 30n).toString()); assert.equal(direct.windowSec, 600);
  assert.equal(direct.liveCapabilitiesApproved, false);
  const b = args(); b.asset.decimals = 6; b.policy.quoteDecimals = 6;
  const inverse = await readOndoV3Twap({ ...b, request: rpc({ inverse: true, delta: -601n, tokenDecimals: 6 }) });
  assert.equal(inverse.meanTick, -2); assert.ok(BigInt(inverse.priceUsdWad) > 10n ** 18n);
  assert.ok(BigInt(inverse.priceUsdWad) <= 10001n * 10n ** 18n / 10000n);
});
test('insufficient history, thin liquidity and stale or wrong quote feeds have no fallback', async () => {
  await assert.rejects(readOndoV3Twap({ ...args(), request: rpc({ fail: true }) }));
  const thin = args(); thin.policy.minHarmonicLiquidity = '1000001';
  await assert.rejects(readOndoV3Twap({ ...thin, request: rpc() }));
  await assert.rejects(readOndoV3Twap({ ...args(), request: rpc({ tokenDecimals: 6 }) }));
  for (const change of [{ updatedAt: 939 }, { updatedAt: 1001 }, { feedId: 'wrong' }, { blockNumber: 101 }, { basis: 'per-share' }]) {
    const a = args(); Object.assign(a.quoteUsd, change); await assert.rejects(readOndoV3Twap({ ...a, request: rpc() }));
  }
});
