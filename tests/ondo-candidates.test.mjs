// The Ethereum Ondo stock candidates (13 November) are well formed and agree with the tokenized-equity registry where
// both list a stock; scripts/stock-list.mjs then checks each one on chain before it can be approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';

const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('Ethereum Ondo candidates: nine stocks (MSTRon added 24 Nov), valid addresses and feeds, at most four days stale, no duplicates, matching the registry', () => {
  const list = read('config/stocks/candidates/ethereum-ondo.json'), registry = read('config/tokenized-equity-registry.json');
  assert.equal(list.length, 9);
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

test('underlying-feed candidates (BNB 13, Ethereum 2): valid, no duplicates, matching the registry, and no overlap with Ethereum’s direct feeds', () => {
  const registry = read('config/tokenized-equity-registry.json'), direct = read('config/stocks/candidates/ethereum-ondo.json').map(s => s.symbol);
  for (const [network, file, count] of [['bnb', 'config/stocks/candidates/bnb-ondo-underlying.json', 13], ['ethereum', 'config/stocks/candidates/ethereum-ondo-underlying.json', 2]]) {
    const list = read(file), seen = new Set();
    assert.equal(list.length, count, file);
    for (const s of list) {
      assert.match(s.symbol, /^[A-Z]{2,6}on$/); getAddress(s.address.toLowerCase()); getAddress(s.underlyingFeed.toLowerCase());
      for (const k of [s.symbol, s.address.toLowerCase(), s.underlyingFeed.toLowerCase()]) { assert.ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
      const known = registry.assets.find(a => a.provider === 'ondo' && a.network === network && a.symbol === s.symbol);
      if (known) assert.equal(known.address.toLowerCase(), s.address.toLowerCase(), `${network} ${s.symbol} matches the registry`);
      if (network === 'ethereum') assert.ok(!direct.includes(s.symbol), `${s.symbol} already has a direct feed`);
    }
  }
});

test('Robinhood Chain Ondo tokens (18 Nov): 15 valid addresses, no duplicates, and no price feed, so the stock list builder cannot use them', () => {
  const list = read('config/stocks/candidates/robinhood-ondo-unpriced.json'), seen = new Set();
  assert.equal(list.length, 15);
  for (const s of list) {
    assert.match(s.symbol, /^[A-Z]{2,6}on$/); getAddress(s.address.toLowerCase());
    assert.equal(s.feed, undefined, `${s.symbol} has no price source on Robinhood Chain yet`);
    assert.equal(s.underlyingFeed, undefined);
    for (const k of [s.symbol, s.address.toLowerCase()]) { assert.ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
  }
});

test('Ethereum swap candidates: every Ondo stock and ETF from the GM token CSV, valid and unique, matching the launch candidates', () => {
  const all = read('config/stocks/candidates/ethereum-ondo-all.json'), direct = read('config/stocks/candidates/ethereum-ondo.json');
  assert.equal(all.length, 474);
  const seen = new Set();
  for (const s of all) {
    assert.match(s.symbol, /^[A-Z0-9]{1,8}on$/, s.symbol);
    assert.ok(['Stock', 'ETF'].includes(s.type), s.symbol);
    getAddress(s.address);
    for (const k of [s.symbol, s.address]) { assert.ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
  }
  for (const d of direct) assert.equal(all.find(s => s.symbol === d.symbol)?.address, d.address.toLowerCase(), `${d.symbol} agrees with the launch list`);
});
