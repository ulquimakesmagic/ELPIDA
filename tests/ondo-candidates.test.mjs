// The Ethereum Ondo stock candidates (13 November) are well formed and agree with the tokenized-equity registry where
// both list a stock; scripts/stock-list.mjs then checks each one on chain before it can be approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';

const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('Ethereum Ondo candidates: eight stocks, valid addresses and feeds, at most four days stale, no duplicates, matching the registry', () => {
  const list = read('config/stocks/candidates/ethereum-ondo.json'), registry = read('config/tokenized-equity-registry.json');
  assert.equal(list.length, 8);
  const seen = new Set();
  for (const s of list) {
    assert.match(s.symbol, /^[A-Z]{2,6}on$/, s.symbol);
    getAddress(s.address.toLowerCase()); getAddress(s.feed.toLowerCase());
    assert.ok(s.maxAge > 0 && s.maxAge <= 4 * 86_400, s.symbol);
    for (const k of [s.symbol, s.address.toLowerCase(), s.feed.toLowerCase()]) { assert.ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
    const known = registry.assets.find(a => a.provider === 'ondo' && a.network === 'ethereum' && a.symbol === s.symbol);
    if (known) assert.equal(known.address.toLowerCase(), s.address.toLowerCase(), `${s.symbol} matches the registry`);
  }
  assert.ok(!list.some(s => s.symbol === 'FLHYon'), 'FLHYon waits until Chainlink lists one calculated feed for it');
});
