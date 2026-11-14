// Hourly USD prices for analytics (14 Nov 2026): fees are valued at the hour they happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceHistory, priceEntries, PRICE_HISTORY_MAX_GAP } from '../apps/api/price-history.mjs';
import { usdReferenceFor } from '../packages/core/pairs.mjs';

test('the price at a moment is the latest hourly value at or before it, never a later one, within 6 hours', () => {
  const h = new PriceHistory(), base = 1_794_600_000 - (1_794_600_000 % 3600);
  assert.equal(h.since(), null);
  h.record([{ network: 'base', asset: 'native', usd: 3000 }], base);
  h.record([{ network: 'base', asset: 'native', usd: 3100 }], base + 3600 + 59);
  h.record([{ network: 'base', asset: 'native', usd: 3150 }], base + 3600 + 1800);
  assert.equal(h.since(), base);
  assert.equal(h.usdAt('base', 'native', base + 10), 3000);
  assert.equal(h.usdAt('base', 'native', base + 3600 + 5), 3150, 'the last value recorded in an hour wins');
  assert.equal(h.usdAt('base', 'native', base - 1), null, 'nothing before the first record');
  assert.equal(h.usdAt('base', 'native', base + 3600 + PRICE_HISTORY_MAX_GAP), 3150);
  assert.equal(h.usdAt('base', 'native', base + 3600 + PRICE_HISTORY_MAX_GAP + 3600), null, 'too old to use');
  assert.equal(h.usdAt('bnb', 'native', base + 10), null);
});

test('bad prices are skipped, and entries come from the price keeper and the tokens\' own references', () => {
  const h = new PriceHistory(), now = 1_794_600_000;
  assert.equal(h.record([{ network: 'base', asset: 'native', usd: 0 }, { network: 'base', asset: 'native', usd: NaN }, { network: '', asset: 'native', usd: 5 }], now), 0);
  const entries = priceEntries({ 'base-sepolia': { status: 'fresh', usd: 3000, source: 'Pyth' }, 'bnb-testnet': { usd: null } },
    [{ network: 'base-sepolia', pair: 'usdc', quoteAddress: '0xAbC' }, { network: 'base-sepolia', pair: 'usdc', quoteAddress: '0xabc' }, { network: 'base-sepolia', pair: 'native' }], usdReferenceFor, now);
  assert.deepEqual(entries.map(e => [e.network, e.asset, e.usd]), [['base-sepolia', 'native', 3000], ['base-sepolia', '0xabc', 1]]);
  assert.equal(h.record(entries, now), 2);
  assert.equal(h.usdAt('base-sepolia', '0xABC', now), 1, 'addresses match whatever their case');
});
