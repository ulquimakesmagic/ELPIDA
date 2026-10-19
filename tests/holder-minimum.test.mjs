import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { minimumHoldingFromUsd, effectiveMinimum } from '../packages/core/holder-minimum.mjs';
import { normalizeRewardPolicy } from '../apps/web/reward-policy.mjs';
import { checkGraduation, realQuoteReserve } from '../packages/core/tokenized-equity.mjs';

const E18 = 10n ** 18n;
test('a $30 minimum converts to tokens at the current USD price and rounds up', () => {
  assert.equal(minimumHoldingFromUsd({ usd: '30', tokenPriceUsd: 0.00003 }), 1_000_000n * E18);
  assert.equal(minimumHoldingFromUsd({ usd: '30', tokenPriceUsd: 0.00007 }) >= 428571n * E18, true);
  assert.equal(minimumHoldingFromUsd({ usd: '0', tokenPriceUsd: null }), 0n);
});
test('the larger of the token and USD minimums applies; no price means wait, not guess', () => {
  const tokens = 500_000n * E18;
  assert.equal(effectiveMinimum({ tokens, usd: '30', tokenPriceUsd: 0.00003 }), 1_000_000n * E18, 'USD minimum is larger');
  assert.equal(effectiveMinimum({ tokens, usd: '5', tokenPriceUsd: 0.00003 }), tokens, 'token minimum is larger');
  assert.equal(effectiveMinimum({ tokens, usd: '30', tokenPriceUsd: null }), null);
  assert.equal(effectiveMinimum({ tokens, usd: '0', tokenPriceUsd: null }), tokens, 'no USD minimum, no price needed');
  assert.throws(() => minimumHoldingFromUsd({ usd: '200000', tokenPriceUsd: 1 }), /out of range/);
});
test('reward policy accepts an optional USD minimum and rejects bad values', () => {
  assert.equal(normalizeRewardPolicy({ mode: 'holders' }).minimumHoldingUsd, '0');
  assert.equal(normalizeRewardPolicy({ mode: 'holders', minimumHoldingUsd: '30' }).minimumHoldingUsd, '30');
  assert.throws(() => normalizeRewardPolicy({ mode: 'holders', minimumHoldingUsd: '-1' }));
  assert.throws(() => normalizeRewardPolicy({ mode: 'holders', minimumHoldingUsd: '100001' }), /\$100,000/);
});
test('configured graduation thresholds are $50,000 market cap and $15,000 real reserve, and both must hold', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url))).graduation;
  assert.deepEqual([cfg.minMarketCapUsd, cfg.minRealReserveUsd], [50000, 15000]);
  const base = { quoteDecimals: 18, quotePriceUsd: 1000, valuation: { usable: true, status: 'ok' }, thresholds: cfg };
  const real = realQuoteReserve({ totalQuoteRaw: 50n * E18, virtualQuoteRaw: 36n * E18 });
  assert.equal(checkGraduation({ ...base, marketCapUsd: 60000, realQuoteRaw: real }).reserveOk, false, '$14,000 real is below $15,000');
  assert.equal(checkGraduation({ ...base, marketCapUsd: 60000, realQuoteRaw: 15n * E18 }).ok, true);
  assert.equal(checkGraduation({ ...base, marketCapUsd: 49999, realQuoteRaw: 15n * E18 }).ok, false);
});
