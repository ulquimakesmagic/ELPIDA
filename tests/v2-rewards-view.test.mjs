// The Rewards section adds every chain together: dollars where an asset has a fresh price, per-symbol amounts always,
// and assets without a price listed in their own units rather than converted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { combine } from '../apps/web/v2-rewards-view.mjs';

test('vaults on several chains read as one total', () => {
  const c = combine([{ n: 0.5, symbol: 'ETH', usd: 1500 }, { n: 0.25, symbol: 'ETH', usd: 750 }, { n: 10, symbol: 'USDC', usd: 10 }, { n: 3, symbol: 'tNVDAon', usd: null }]);
  assert.equal(c.headline, '$2.26K'); assert.equal(c.usd, 2260);
  assert.equal(c.detail, '0.75 ETH · 10 USDC · 3 tNVDAon', 'ETH from two chains adds up');
  assert.deepEqual(c.extra, ['3 tNVDAon'], 'the unpriced asset is named, not converted');
});

test('empty vaults and unpriced-only vaults', () => {
  assert.deepEqual(combine([]), { headline: '$0', detail: '', usd: 0, extra: [] });
  assert.deepEqual(combine([{ n: 0, symbol: 'ETH', usd: 0 }]), { headline: '$0', detail: '', usd: 0, extra: [] });
  assert.deepEqual(combine([{ n: 2, symbol: 'BNB', usd: null }, { n: 1, symbol: 'USDC', usd: null }]), { headline: '2 BNB', detail: '1 USDC', usd: null, extra: [] });
});
