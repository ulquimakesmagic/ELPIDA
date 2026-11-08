import test from 'node:test';
import assert from 'node:assert/strict';
import {
  V2, V2_FEE_SPLIT, V2_PROPOSED_MIN_FEE_BPS, priceMultiple, virtualToken, virtualQuote, saleTokens, validateFeeBps,
  feeOn, splitFee, firstBuyCapTokens, quoteFirstBuy, maxFirstBuyGross, isValidTicker, saleTicks,
} from '../packages/core/v2-economics.mjs';

const E18 = 10n ** 18n;
const USDC = { quoteUsdE6: 1_000_000n, quoteDecimals: 6 };
const minBps = V2_PROPOSED_MIN_FEE_BPS;

test('V2 parameters match the approved spec', () => {
  assert.equal(V2.launchFeeUsdE6, 10_000_000n);
  assert.equal(V2.startFdvUsdE6, 20_000n * 10n ** 6n);
  assert.equal(V2.graduationFdvUsdE6, 100_000n * 10n ** 6n);
  assert.equal(V2.defaultFeeBps, 125);
  assert.equal(V2.maxFeeBps, 400);
  assert.equal(V2.firstBuyCapBps, 300);
  assert.deepEqual(V2_FEE_SPLIT, { creator: 3000, traderAirdrop: 3000, flywheel: 1000, holderRewards: 1000, treasury: 2000 });
});

test('the curve starts at $20k and graduates at $100k with price continuity', () => {
  assert.equal(priceMultiple(), 5n);
  const vT = virtualToken();
  assert.equal(vT, 1_250_000_000n * E18, 'vT = 5/4 of supply');
  const vQ = virtualQuote(USDC);
  assert.equal(vQ, 25_000n * 10n ** 6n, '$25,000 virtual USDC');
  // Start price × supply = $20,000 (quote units, 6 decimals).
  assert.equal(vQ * V2.tokenSupply / vT, 20_000n * 10n ** 6n);
  // At graduation: tokens left = supply − sold; price there is r × start; pool quote = raise.
  const sold = saleTokens();
  const remainingVirtual = vT - sold;
  const raise = vQ * vT / remainingVirtual - vQ;
  const gradPriceTimesSupply = (vQ + raise) * V2.tokenSupply / remainingVirtual; // FDV at the last curve price
  assert.ok(gradPriceTimesSupply >= 99_999n * 10n ** 6n && gradPriceTimesSupply <= 100_001n * 10n ** 6n, `graduation FDV ${gradPriceTimesSupply}`);
  const lpTokens = V2.tokenSupply - sold;
  const poolFdv = raise * V2.tokenSupply / lpTokens; // pool price from its own reserves
  assert.ok(poolFdv >= 99_999n * 10n ** 6n && poolFdv <= 100_001n * 10n ** 6n, 'pool opens at the curve’s last price');
  assert.ok(raise > 30_901n * 10n ** 6n && raise < 30_903n * 10n ** 6n, 'raises about $30,902 before fees');
  assert.ok(sold * 10_000n / V2.tokenSupply === 6909n, 'sells 69.1% of supply');
});

test('virtual quote follows the quote asset price and decimals', () => {
  const eth = virtualQuote({ quoteUsdE6: 2_500_000_000n, quoteDecimals: 18 });
  assert.equal(eth, 10n * E18, '$25,000 of ETH at $2,500');
  assert.throws(() => virtualQuote({ quoteUsdE6: 0n, quoteDecimals: 18 }));
});

test('Model 11-style sale range for ×5 is 16,100 ticks, never cheaper than ×5', () => {
  assert.equal(saleTicks(5, 10), 16_100);
  assert.ok(Math.pow(1.0001, 16_100) >= 5 && Math.pow(1.0001, 16_090) < 5);
  assert.equal(saleTicks(10, 10), 23_030, 'matches the deployed Model 11 hook for ×10');
});

test('fees: default 1.25%, exactly 4% allowed, above 4% and below the minimum rejected', () => {
  assert.equal(validateFeeBps(125, { minBps }), 125);
  assert.equal(validateFeeBps(400, { minBps }), 400);
  assert.throws(() => validateFeeBps(401, { minBps }), /4% maximum/);
  assert.throws(() => validateFeeBps(minBps - 1, { minBps }), /minimum/);
  assert.throws(() => validateFeeBps(125.5, { minBps }), /whole/);
  assert.throws(() => validateFeeBps(125, {}), /Minimum fee must be set/);
  assert.equal(feeOn(100_000n * 10n ** 6n, 125), 1_250n * 10n ** 6n);
});

test('five-way split matches the spec example and any allowed fee', () => {
  const fee = feeOn(100_000n * 10n ** 6n, 125);
  assert.deepEqual(splitFee(fee), { creator: 375_000_000n, traderAirdrop: 375_000_000n, flywheel: 125_000_000n, holderRewards: 125_000_000n, treasury: 250_000_000n });
  const four = splitFee(feeOn(100_000n * 10n ** 6n, 400));
  assert.deepEqual(four, { creator: 1_200_000_000n, traderAirdrop: 1_200_000_000n, flywheel: 400_000_000n, holderRewards: 400_000_000n, treasury: 800_000_000n });
});

test('split conserves every base unit; rounding dust goes to the treasury only', () => {
  for (let fee = 0n; fee < 2_000n; fee++) {
    const s = splitFee(fee);
    assert.equal(s.creator + s.traderAirdrop + s.flywheel + s.holderRewards + s.treasury, fee);
    assert.ok(s.creator * 10_000n <= fee * 3_000n && s.flywheel * 10_000n <= fee * 1_000n);
    assert.ok(s.treasury * 10_000n >= fee * 2_000n && s.treasury * 10_000n < fee * 2_000n + 4n * 10_000n);
  }
  assert.throws(() => splitFee(1n, { ...V2_FEE_SPLIT, treasury: 1999 }), /10,000/);
});

test('first buy: zero allowed, exactly 3% allowed, above 3% rejected', () => {
  const vQ = virtualQuote(USDC);
  assert.equal(firstBuyCapTokens(), 30_000_000n * E18);
  assert.deepEqual(quoteFirstBuy({ gross: 0n, feeBps: 125, vQ }), { gross: 0n, fee: 0n, tokens: 0n });
  const small = quoteFirstBuy({ gross: 100n * 10n ** 6n, feeBps: 125, vQ });
  assert.ok(small.tokens > 0n && small.tokens < firstBuyCapTokens());
  for (const feeBps of [100, 125, 250, 400]) {
    const max = maxFirstBuyGross({ feeBps, vQ });
    const at = quoteFirstBuy({ gross: max, feeBps, vQ });
    assert.ok(at.tokens <= firstBuyCapTokens(), 'the maximum stays within the cap');
    // One micro-USDC buys about 0.05 tokens at the start price, so the cap is reached to within that.
    assert.ok(firstBuyCapTokens() - at.tokens < 10n ** 17n, 'and reaches it to within one quote unit');
    assert.throws(() => quoteFirstBuy({ gross: max + 1n, feeBps, vQ }), /3% of supply/);
  }
  // At the default fee the cap costs about $623 in USDC.
  const max = maxFirstBuyGross({ feeBps: 125, vQ });
  assert.ok(max > 622n * 10n ** 6n && max < 624n * 10n ** 6n, `cap costs ${max}`);
});

test('tickers: 1–10 ASCII letters or digits; duplicates are not a format concern', () => {
  for (const ok of ['A', 'ELPIDA', 'pepe2', '1234567890']) assert.equal(isValidTicker(ok), true, ok);
  for (const bad of ['', 'ABCDEFGHIJK', 'PE PE', 'PEPE!', 'ÉLP', 'ELP\n', null]) assert.equal(isValidTicker(bad), false, String(bad));
});
