// A stock-paired token on mainnet had no dollar reference: usdReferenceFor only knew the simulated test issuer, so
// market cap, USD volume and creator fees came out blank. These tests pin the reference the server now attaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stockReferenceFrom, StockReferences, STOCK_REFERENCE_VERSION } from '../packages/core/stock-prices.mjs';

const NOW = 1_795_296_000; // 21 November 2026
const FOUR_DAYS = 345_600;

test('a fresh feed reading becomes a usable dollar reference', () => {
  const ref = stockReferenceFrom({ price: 344.55, updatedAt: NOW - 3600, maxAge: FOUR_DAYS, source: 'AAPLon / USD (Chainlink AAPL / USD x Ondo sValue)', feed: '0x11bb2cE3e9938846C43Df77D79CAABbd7C7590E7', now: NOW });
  assert.equal(ref.status, 'fresh');
  assert.equal(ref.usd, 344.55);
  assert.equal(ref.maxAge, FOUR_DAYS);
  assert.match(ref.source, /AAPLon/);
  assert.equal(ref.version, STOCK_REFERENCE_VERSION);
});

test('a reading older than the factory window is labelled stale, not fresh and not dropped', () => {
  const ref = stockReferenceFrom({ price: 344.55, updatedAt: NOW - FOUR_DAYS - 60, maxAge: FOUR_DAYS, now: NOW });
  assert.equal(ref.status, 'stale', 'the page can say how old it is instead of showing nothing');
  assert.equal(ref.usd, 344.55);
});

test('an unusable reading yields no reference at all', () => {
  assert.equal(stockReferenceFrom({ price: 0, updatedAt: NOW, maxAge: FOUR_DAYS, now: NOW }), null);
  assert.equal(stockReferenceFrom({ price: -1, updatedAt: NOW, maxAge: FOUR_DAYS, now: NOW }), null);
  assert.equal(stockReferenceFrom({ price: 1, updatedAt: 0, maxAge: FOUR_DAYS, now: NOW }), null);
  assert.equal(stockReferenceFrom({ price: 'nonsense', updatedAt: NOW, maxAge: FOUR_DAYS, now: NOW }), null);
  // A feed stamped far in the future is not evidence.
  assert.equal(stockReferenceFrom({ price: 1, updatedAt: NOW + 3600, maxAge: FOUR_DAYS, now: NOW }), null);
});

test('a missing maxAge falls back to a day rather than accepting anything', () => {
  const ref = stockReferenceFrom({ price: 2, updatedAt: NOW - 90_000, maxAge: 0, now: NOW });
  assert.equal(ref.maxAge, 86_400);
  assert.equal(ref.status, 'stale');
});

test('the cache keys by network and quote, and a failed read keeps the last good value', async () => {
  let fail = false;
  const cache = new StockReferences({ now: () => NOW, read: async () => { if (fail) throw new Error('rpc down'); return { price: 344.55, updatedAt: NOW - 60, maxAge: FOUR_DAYS, source: 'AAPLon feed' }; } });
  const quotes = [{ network: 'bnb-mainnet', quote: '0x390a684EF9cADE28A7AD0DFa61AB1Eb3842618c4' }];

  assert.equal(cache.get('bnb-mainnet', quotes[0].quote), null, 'nothing before the first refresh');
  assert.equal(await cache.refresh(quotes), 1);
  assert.equal(cache.get('bnb-mainnet', quotes[0].quote).usd, 344.55);
  assert.equal(cache.get('base-mainnet', quotes[0].quote), null, 'another network is a different key');

  fail = true;
  assert.equal(await cache.refresh(quotes), 0);
  assert.equal(cache.get('bnb-mainnet', quotes[0].quote).usd, 344.55, 'a failed read does not blank the page');
});

test('quotesOf ignores the native coin and USDC, and repeats', () => {
  const native = '0x0000000000000000000000000000000000000000';
  const usdc = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
  const aapl = '0x390a684EF9cADE28A7AD0DFa61AB1Eb3842618c4';
  const quotes = StockReferences.quotesOf([
    { quoteAddress: native }, { quoteAddress: usdc }, { quoteAddress: aapl }, { quoteAddress: aapl.toUpperCase().replace('0X', '0x') }, { quoteAddress: null },
  ], { native, usdc });
  assert.deepEqual(quotes.map(q => q.toLowerCase()), [aapl.toLowerCase()]);
});
