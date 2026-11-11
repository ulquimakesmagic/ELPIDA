// The Rewards section adds every chain together in dollars (Malik, 11 Nov: USD only, never the native coin or the
// stock pair). Assets without a fresh price are left out of the total and named, never shown as units.
import test from 'node:test';
import assert from 'node:assert/strict';
import { combine } from '../apps/web/v2-rewards-view.mjs';

test('vaults on several chains read as one total', () => {
  const c = combine([{ n: 0.5, symbol: 'ETH', usd: 1500 }, { n: 0.25, symbol: 'ETH', usd: 750 }, { n: 10, symbol: 'USDC', usd: 10 }, { n: 3, symbol: 'tNVDAon', usd: null }]);
  assert.equal(c.headline, '$2.26K'); assert.equal(c.usd, 2260);
  assert.equal(c.detail, '', 'no native or pair-asset amounts');
  assert.deepEqual(c.extra, ['tNVDAon'], 'the unpriced asset is named, not converted');
});

test('empty vaults and unpriced-only vaults', () => {
  assert.deepEqual(combine([]), { headline: '$0', detail: '', usd: 0, extra: [] });
  assert.deepEqual(combine([{ n: 0, symbol: 'ETH', usd: 0 }]), { headline: '$0', detail: '', usd: 0, extra: [] });
  assert.deepEqual(combine([{ n: 2, symbol: 'BNB', usd: null }, { n: 1, symbol: 'USDC', usd: null }]), { headline: 'Awaiting a price', detail: '', usd: null, extra: ['BNB', 'USDC'] });
});
