import test from 'node:test';
import assert from 'node:assert/strict';
import { valueOndoReserve } from '../packages/core/ondo-valuation.mjs';

const token = '0x' + 'ab'.repeat(20), pool = '0x' + 'cd'.repeat(20), WAD = 10n ** 18n;
const asset = { provider: 'ondo', network: 'ethereum', address: token, decimals: 18 };
const policy = { network: 'ethereum', token, pool, verificationId: 'simulation-only-policy', feedId: 'test-total-return-feed', maxAgeSec: 60, minTwapWindowSec: 600, maxDivergenceBps: 300 };
const reference = { network: 'ethereum', token, feedId: policy.feedId, currency: 'USD', basis: 'per-raw-token', priceUsdWad: String(105n * WAD), updatedAt: 990, statusUpdatedAt: 990, assetStatus: 'tradable', corporateAction: 'none' };
const twap = { network: 'ethereum', token, pool, currency: 'USD', basis: 'per-raw-token', priceUsdWad: String(104n * WAD), updatedAt: 995, windowSec: 900 };
const input = () => ({ asset: { ...asset }, policy: { ...policy }, reference: { ...reference }, twap: { ...twap }, balanceRaw: 3n * WAD, now: 1000 });

test('total-return valuation uses raw balances once and the lower independent price, with exact arithmetic', () => {
  const args = input(); args.reference.sharesMultiplierWad = String(2n * WAD);
  const value = valueOndoReserve(args);
  assert.equal(value.usable, true); assert.equal(value.priceUsdWad, 104n * WAD); assert.equal(value.valueUsdWad, 312n * WAD);
  assert.equal(valueOndoReserve({ ...args, balanceRaw: 1n }).valueUsdWad, 104n);
  assert.equal(valueOndoReserve({ ...args, balanceRaw: '900719925474099312345678' }).valueUsdWad, 900719925474099312345678n * 104n);
  const six = input(); six.asset.decimals = 6; six.balanceRaw = '1500000';
  assert.equal(valueOndoReserve(six).valueUsdWad, 156n * WAD);
});

test('underlying-share and display-unit prices never become token prices implicitly', () => {
  for (const basis of ['per-share', 'per-display-unit', undefined]) for (const field of ['reference', 'twap']) {
    const args = input(); args[field].basis = basis;
    assert.equal(valueOndoReserve(args).usable, false);
  }
});

test('stale, future, missing and unsafe status/price timestamps block valuation', () => {
  for (const [field, property] of [['reference', 'updatedAt'], ['reference', 'statusUpdatedAt'], ['twap', 'updatedAt']]) {
    for (const timestamp of [939, 1001, undefined, NaN, 1.5]) {
      const args = input(); args[field][property] = timestamp;
      assert.equal(valueOndoReserve(args).usable, false, `${field}.${property}=${timestamp}`);
    }
  }
  for (const property of ['assetStatus', 'corporateAction']) {
    const args = input(); args.reference[property] = 'unknown';
    assert.equal(valueOndoReserve(args).usable, false);
  }
});

test('cross-chain, look-alike, feed and pool substitutions are rejected', () => {
  for (const field of ['reference', 'twap', 'policy']) {
    const args = input(); args[field].network = 'bnb'; assert.equal(valueOndoReserve(args).usable, false);
    const other = input(); other[field].token = '0x' + 'ee'.repeat(20); assert.equal(valueOndoReserve(other).usable, false);
  }
  const wrongPool = input(); wrongPool.twap.pool = token; assert.equal(valueOndoReserve(wrongPool).usable, false);
  const wrongFeed = input(); wrongFeed.reference.feedId = 'unapproved'; assert.equal(valueOndoReserve(wrongFeed).usable, false);
  assert.equal(valueOndoReserve({ ...input(), policy: null }).usable, false);
});

test('unknown policy, insufficient TWAP history, divergence and imprecise integer inputs fail closed', () => {
  for (const change of [{ verificationId: null }, { maxAgeSec: NaN }, { maxDivergenceBps: -1 }, { maxDivergenceBps: 10001 }, { minTwapWindowSec: 0 }]) assert.equal(valueOndoReserve({ ...input(), policy: { ...policy, ...change } }).usable, false);
  const short = input(); short.twap.windowSec = 599; assert.equal(valueOndoReserve(short).usable, false);
  const divergent = input(); divergent.twap.priceUsdWad = String(120n * WAD); assert.equal(valueOndoReserve(divergent).usable, false);
  for (const balanceRaw of [-1n, '1.2', 9007199254740993, undefined]) assert.equal(valueOndoReserve({ ...input(), balanceRaw }).usable, false);
  const invalid = input(); invalid.reference.priceUsdWad = '0'; assert.equal(valueOndoReserve(invalid).usable, false);
});
