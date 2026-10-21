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
