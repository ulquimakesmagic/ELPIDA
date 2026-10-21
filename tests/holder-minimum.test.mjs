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
test('configured stock-pair graduation rule is on-completion, and Model 10 shows why the old $15,000 floor was retired', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url))).graduation;
  assert.equal(cfg.rule, 'on-completion');
  assert.deepEqual([cfg.supersedes.minMarketCapUsd, cfg.supersedes.minRealReserveUsd], [50000, 15000]);
  // Model 10 from the contract constants: virtualToken = 1B x 10/9, SALE_CAP = 1B x sqrt(10)/(sqrt(10)+1), start FDV $5,000.
  const vT = 1e9 * 10 / 9, cap = 759746926.647958, vQ = 5000 * vT / 1e9;
  const reserveUsd = vQ * (vT / (vT - cap) - 1);
  assert.ok(Math.abs(reserveUsd - 12012.65) < 1, `real reserve at completion is about $12,013 (got ${reserveUsd})`);
  assert.ok(reserveUsd < cfg.supersedes.minRealReserveUsd, 'the retired $15,000 floor was unreachable');
  assert.ok(Math.abs(1e9 * (vQ + reserveUsd) / (vT - cap) - 50000) < 1, 'completion market cap is $50,000');
  const ready = checkGraduation({ rule: cfg.rule, complete: true, valuation: { usable: true, status: 'ok' }, realQuoteRaw: realQuoteReserve({ totalQuoteRaw: 50n * E18, virtualQuoteRaw: 38n * E18 }), quoteDecimals: 18, quotePriceUsd: 1000 });
  assert.equal(ready.ok, true);
});
