import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOndoMarket } from '../packages/core/ondo-market.mjs';
const token = '0x' + 'ab'.repeat(20), pool = '0x' + 'cd'.repeat(20), quote = '0x' + 'ef'.repeat(20), WAD = 10n ** 18n;
const input = () => {
  const identity = { network: 'ethereum', token }, snapshot = { blockNumber: 123, blockHash: '0x' + '12'.repeat(32), updatedAt: 995 };
  return { asset: { ...identity, provider: 'ondo', address: token, decimals: 18 }, balanceRaw: 2n * WAD, now: 1000,
    policy: { ...identity, pool, verificationId: 'test-only', feedId: 'total-return', maxAgeSec: 60, minTwapWindowSec: 600, maxDivergenceBps: 300,
      quoteToken: quote, quoteDecimals: 6, quoteFeedId: 'quote-usd', maxSampleSkewSec: 10, maxExecutionLossBps: 200, minSellProbeRaw: WAD, buyProbeQuoteRaw: '200000000', minProbeUsdWad: 100n * WAD },
    reference: { ...identity, priceUsdWad: 100n * WAD, updatedAt: 990, statusUpdatedAt: 990, feedId: 'total-return', currency: 'USD', basis: 'per-raw-token', assetStatus: 'tradable', corporateAction: 'none' },
    twap: { ...identity, ...snapshot, pool, priceUsdWad: 99n * WAD, currency: 'USD', basis: 'per-raw-token', windowSec: 900 },
    quoteUsd: { ...snapshot, network: 'ethereum', token: quote, feedId: 'quote-usd', currency: 'USD', basis: 'per-raw-token', priceUsdWad: WAD },
    liquidity: { ...identity, ...snapshot, pool, quoteToken: quote, sell: { amountInRaw: 2n * WAD, amountOutRaw: '197000000' }, buy: { amountInRaw: '200000000', amountOutRaw: 198n * WAD / 100n } } };
};

test('conservative reserve value respects full-size executable exit and never authorizes trading', () => {
  const args = input(); args.reference.sharesMultiplierWad = 2n * WAD;
  const r = validateOndoMarket(args);
  assert.equal(r.usable, true); assert.equal(r.valueUsdWad, 197n * WAD);
  assert.equal(r.liveCapabilitiesApproved, false);
});
test('fresh prices do not excuse a shallow, wrong-size or one-sided execution sample', () => {
  for (const [side, field, value] of [['sell', 'amountInRaw', WAD], ['sell', 'amountInRaw', 3n * WAD], ['sell', 'amountOutRaw', '195999999'], ['buy', 'amountOutRaw', WAD], ['buy', 'amountInRaw', '100000000']]) {
    const a = input(); a.liquidity[side][field] = value; assert.equal(validateOndoMarket(a).usable, false);
  }
  const a = input(); a.policy.minProbeUsdWad = 201n * WAD; assert.equal(validateOndoMarket(a).usable, false);
  const exact = input(); exact.liquidity.sell.amountOutRaw = '196000000'; assert.equal(validateOndoMarket(exact).usable, true);
});
test('USD quote valuation handles depegs and refuses stale or substituted observations', () => {
  const a = input(); a.quoteUsd.priceUsdWad = 9n * WAD / 10n; assert.equal(validateOndoMarket(a).usable, false);
  for (const field of ['liquidity', 'quoteUsd', 'twap']) for (const change of [{ blockHash: '0x' + '34'.repeat(32) }, { blockNumber: 124 }, { updatedAt: 939 }, { updatedAt: 1001 }]) {
    const b = input(); Object.assign(b[field], change); assert.equal(validateOndoMarket(b).usable, false);
  }
  for (const change of [{ token }, { feedId: 'wrong' }, { basis: 'per-share' }, { network: 'bnb' }]) {
    const b = input(); Object.assign(b.quoteUsd, change); assert.equal(validateOndoMarket(b).usable, false);
  }
  const skew = input(); skew.quoteUsd.updatedAt = 970; assert.equal(validateOndoMarket(skew).usable, false);
});
test('missing review limits, unknown corporate actions and imprecise amounts fail closed', () => {
  for (const change of [{ quoteDecimals: 19 }, { quoteFeedId: '' }, { minSellProbeRaw: 0n }, { maxExecutionLossBps: 10000 }, { maxSampleSkewSec: 0 }, { buyProbeQuoteRaw: 200000000 }]) {
    const a = input(); Object.assign(a.policy, change); assert.equal(validateOndoMarket(a).usable, false);
  }
  const a = input(); a.reference.corporateAction = 'unknown'; assert.equal(validateOndoMarket(a).usable, false);
});
