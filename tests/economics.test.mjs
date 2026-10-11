import test from 'node:test';
import assert from 'node:assert/strict';
import { feeSplit, buyQuote, sellQuote, LAUNCH_FEE_USDC } from '../packages/core/economics.mjs';

test('launch fee is exactly 10 USDC in 6-decimal units', () => assert.equal(LAUNCH_FEE_USDC, 10_000_000n));
test('1.25% fee and 50/50 fee split (rounding to creator)', () => {
  const result = feeSplit(100_000_000n);
  assert.equal(result.fee, 1_250_000n);
  assert.equal(result.protocol, 625_000n);
  assert.equal(result.creator, 625_000n);
  assert.equal(result.net, 98_750_000n);
});
test('reject zero first buy', () => assert.throws(() => feeSplit(0n)));
test('tiny positive buys can fail if too small to mint tokens', () => {
  assert.throws(() => buyQuote({ gross: 1n, virtualQuote: 30_000_000_000n, virtualToken: 1n, reserve: 0n, sold: 0n }));
});
test('buy creates a real reserve and a sell is bounded by it', () => {
  const q = 30_000_000_000n, t = 1_500_000_000n * 10n ** 18n;
  const buy = buyQuote({ gross: 100_000_000n, virtualQuote: q, virtualToken: t, reserve: 0n, sold: 0n });
  assert.ok(buy.out > 0n);
  const sell = sellQuote({ tokenIn: buy.out, virtualQuote: q, virtualToken: t, reserve: buy.net, sold: buy.out });
  assert.ok(sell.net > 0n && sell.net < buy.net);
});
