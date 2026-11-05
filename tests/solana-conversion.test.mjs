// The devnet SOL/stock conversion pool (test builds of the Solana program only): client math, seeding plan and the
// launch form's eligibility. The validator test in tests/solana.test.mjs exercises the program itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DISCRIMINATORS, TEST_CONVERSION_FEE_BPS, testConversionOut, decodeTestConversion } from '../packages/solana/client.mjs';
import { conversionSeedPlan, MAX_SEED_SOL } from '../scripts/lib/solana-conversion-plan.mjs';

const disc = name => [...createHash('sha256').update(name).digest().subarray(0, 8)];

test('conversion pool instructions and account use the program\'s discriminators', () => {
  assert.deepEqual(DISCRIMINATORS.seedTestConversion, disc('global:seed_test_conversion'));
  assert.deepEqual(DISCRIMINATORS.testConversionSwap, disc('global:test_conversion_swap'));
  assert.deepEqual(DISCRIMINATORS.TestConversion, disc('account:TestConversion'));
});

test('conversion quotes mirror the program: x·y = k after a 0.3% fee, never the whole reserve', () => {
  assert.equal(TEST_CONVERSION_FEE_BPS, 30n);
  assert.equal(testConversionOut(2_000_000_000n, 430_000_000n, 1_000_000_000n), 430_000_000n * 997_000_000n / 2_997_000_000n);
  assert.equal(testConversionOut(0n, 1n, 1n), null);
  assert.equal(testConversionOut(1_000_000n, 1n, 1n), null, 'rounds to zero');
  const big = testConversionOut(10n, 1_000n, 10n ** 18n);
  assert.ok(big < 1_000n, 'never the whole reserve');
});

test('the pool account decodes reserves after its discriminator', () => {
  const data = new Uint8Array(8 + 32 + 8 + 8 + 1);
  data.set(DISCRIMINATORS.TestConversion, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(40, 2_000_000_000n, true); view.setBigUint64(48, 430_000_000n, true);
  assert.deepEqual({ ...decodeTestConversion(data), quoteMint: undefined }, { quoteMint: undefined, solReserve: 2_000_000_000n, quoteReserve: 430_000_000n });
  assert.equal(decodeTestConversion(new Uint8Array(57)), null, 'wrong discriminator');
  assert.equal(decodeTestConversion(null), null);
});

test('seeding plan prices the stock at the given dollar price against SOL/USD', () => {
  const plan = conversionSeedPlan({ sol: '1', solUsd: 95.2, stockUsd: '440', decimals: 9 });
  assert.equal(plan.solAmount, 1_000_000_000n);
  assert.equal(plan.stockAmount, 1_000_000_000n * 95_200_000n * 10n ** 9n / (440_000_000n * 1_000_000_000n));
  assert.ok(Math.abs(plan.solPerStock - 440 / 95.2) < 1e-9);
  assert.throws(() => conversionSeedPlan({ sol: String(MAX_SEED_SOL + 1), solUsd: 95, stockUsd: '440', decimals: 9 }), /between 0 and 10 SOL/);
  assert.throws(() => conversionSeedPlan({ sol: '1', solUsd: 95, stockUsd: '0', decimals: 9 }), /positive price/);
  assert.throws(() => conversionSeedPlan({ sol: '1', solUsd: 95, stockUsd: undefined, decimals: 9 }), /positive price/);
});
