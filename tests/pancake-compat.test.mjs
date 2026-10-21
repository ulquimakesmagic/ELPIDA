// PancakeSwap v3 compatibility of the graduation adapter (21 Oct 2026). PancakeSwap v3 is a Uniswap v3 fork with two
// differences that matter here, both confirmed from @pancakeswap/v3-core 1.0.2: slot0().feeProtocol is uint32 (two packed
// 16-bit fees, so real values exceed 255) instead of uint8, and pools call pancakeV3SwapCallback instead of
// uniswapV3SwapCallback. The adapter reads slot0 on EVERY graduation, so the old declaration would revert on BNB Chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dexFixture, art, fixtureArt } from './helpers/dex-fixture.mjs';

const PANCAKE_FEE_PROTOCOL = 216272100; // 3300 | (3300 << 16): 33% protocol fee on both tokens, a realistic value

test('the adapter decodes a PancakeSwap slot0 (uint32 feeProtocol); the old Uniswap-only declaration reverts', async t => {
  const f = await dexFixture(t);
  const pool = await f.deploy(fixtureArt('PancakeSlot0Probe', 'MockPancakeSlot0Pool'), PANCAKE_FEE_PROTOCOL);
  const probe = await f.deploy(fixtureArt('PancakeSlot0Probe', 'Slot0Probe'));
  assert.equal(await probe.readWithAdapterInterface(pool.target), 1n << 96n, 'adapter interface reads the price');
  await assert.rejects(probe.readWithUniswapOnlyInterface(pool.target), 'the pre-fix uint8 declaration fails on PancakeSwap values');
  const small = await f.deploy(fixtureArt('PancakeSlot0Probe', 'MockPancakeSlot0Pool'), 0);
  assert.equal(await probe.readWithUniswapOnlyInterface(small.target), 1n << 96n, 'values under 256 (Uniswap) decode either way');
});

test('the adapter answers both swap-callback names, with the same guard', async t => {
  const f = await dexFixture(t), adapter = f.nativeAdapter;
  const abi = art('ElpidaV3MigrationAdapter').abi.filter(x => x.type === 'function').map(x => x.name);
  assert.ok(abi.includes('uniswapV3SwapCallback') && abi.includes('pancakeV3SwapCallback'));
  for (const name of ['uniswapV3SwapCallback', 'pancakeV3SwapCallback']) await assert.rejects(adapter[name](1n, 0n, '0x'), /rebalance callback/, `${name} pays only the pool being rebalanced during a migration`);
});

test('the shared pool ABI decodes PancakeSwap Swap events and slot0, and still decodes Uniswap ones', async () => {
  const { Interface, AbiCoder, zeroPadValue } = await import('ethers');
  const { v3PoolAbi, v3Artifacts } = await import('../packages/core/uniswap.mjs');
  const i = new Interface(v3PoolAbi()), coder = AbiCoder.defaultAbiCoder();
  const pancake = i.getEvent('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
  const uni = i.getEvent('Swap(address,address,int256,int256,uint160,uint128,int24)');
  const sender = zeroPadValue('0x00000000000000000000000000000000000000aa', 32), recipient = zeroPadValue('0x00000000000000000000000000000000000000bb', 32);
  const log = (ev, extra) => ({ topics: [ev.topicHash, sender, recipient], data: coder.encode(['int256', 'int256', 'uint160', 'uint128', 'int24', ...extra.map(() => 'uint128')], [-5n, 7n, 1n << 96n, 10n, 0, ...extra]) });
  for (const [ev, extra] of [[pancake, [1n, 2n]], [uni, []]]) {
    const parsed = i.parseLog(log(ev, extra));
    assert.equal(parsed.name, 'Swap'); assert.equal(parsed.args.amount0, -5n); assert.equal(parsed.args.amount1, 7n);
  }
  const slot = coder.encode(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint32', 'bool'], [1n << 96n, 0, 0, 1, 1, PANCAKE_FEE_PROTOCOL, true]);
  assert.equal(i.decodeFunctionResult('slot0', slot)[5], BigInt(PANCAKE_FEE_PROTOCOL), 'PancakeSwap slot0 decodes');
  // ethers masks rather than throws, so the old uint8 declaration silently reads a wrong feeProtocol.
  assert.notEqual(new Interface(v3Artifacts.pool.abi).decodeFunctionResult('slot0', slot)[5], BigInt(PANCAKE_FEE_PROTOCOL), 'the plain Uniswap ABI misreads it');
});
