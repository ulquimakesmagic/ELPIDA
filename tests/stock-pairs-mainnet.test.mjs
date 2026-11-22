// Real stock pairs on mainnet (Malik, 21 Nov 2026: SPIDERMAN/AAPLon on BNB Chain showed no price and sat under "Tokens").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StockPrices } from '../apps/api/stock-prices.mjs';

const AAPL = '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4', FEED = '0x11bb2cE3e9938846C43Df77D79CAABbd7C7590E7';
const list = { stocks: [{ symbol: 'AAPLon', address: AAPL, feed: FEED, feedDecimals: 8, feedDescription: 'AAPLon / USD', maxAge: 345600 }] };

test('a real stock pair is marked xstock and priced from its approved feed; other rows are unchanged', async () => {
  const now = 1_800_000_000, calls = [];
  const provider = { call: async tx => { calls.push(tx.to); const { AbiCoder } = await import('ethers'); return AbiCoder.defaultAbiCoder().encode(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], [1, 34_455_000_000n, now - 60, now - 60, 1]); }, getNetwork: async () => ({ chainId: 56n }) };
  const p = new StockPrices({ networks: ['bnb-mainnet'], listFor: k => (k === 'bnb-mainnet' ? list : null), providerFor: () => provider, now: () => now });
  const row = { address: '0xeeca39f2af81296de89685e6ddda58acd5ba1053', pair: 'token', quoteAddress: '0x390A684EF9cade28A7AD0dFa61ab1eB3842618c4', quoteSymbol: 'AAPLon' };
  assert.equal(p.decorate('bnb-mainnet', row).pair, 'xstock', 'marked a stock before the first price read');
  assert.equal(p.decorate('bnb-mainnet', row).usdReference, undefined);
  await p.refresh();
  const d = p.decorate('bnb-mainnet', row);
  assert.equal(d.pair, 'xstock'); assert.equal(d.usdReference.status, 'fresh'); assert.equal(d.usdReference.usd, 344.55); assert.equal(d.stock.symbol, 'AAPLon');
  assert.equal(calls[0].toLowerCase(), FEED.toLowerCase(), 'reads the feed the launchpad approved');
  for (const other of [{ ...row, pair: 'native', quoteAddress: '0x0000000000000000000000000000000000000000' }, { ...row, quoteAddress: '0x' + '9'.repeat(40) }]) assert.deepEqual(p.decorate('bnb-mainnet', other), other);
  assert.deepEqual(p.decorate('base-mainnet', row), row, 'another network\'s list is not used');
  const stale = new StockPrices({ networks: ['bnb-mainnet'], listFor: () => list, providerFor: () => provider, now: () => now + 400_000 }); await stale.refresh();
  assert.equal(stale.reference('bnb-mainnet', AAPL).status, 'stale');
  assert.equal(d.usdReference.version, 1, 'the #346 reference shape');
});

test('wiring: listings are decorated, the token page reads the pair balance and trades natively through KyberSwap on mainnet', async () => {
  const idx = readFileSync(new URL('../apps/api/public-indexer.mjs', import.meta.url), 'utf8');
  assert.match(idx, /return this\.decorate\(key,\{\.\.\.t,\.\.\.s,metadata/); assert.match(idx, /e\.index\.listings\(\)\.map\(t=>this\.decorate\(key,/);
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /publicIndex\.decorate=\(key,t\)=>stockPrices\.decorate\(key,t\);/);
  const { usdReferenceFor } = await import('../packages/core/pairs.mjs');
  const ref = { status: 'fresh', usd: 344.55, updatedAt: 1, maxAge: 345600 };
  assert.deepEqual(usdReferenceFor({ pair: 'xstock', network: 'bnb-mainnet', usdReference: ref }, null), ref, 'the page keeps the server\'s stock reference');
  const wallet = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.match(wallet, /if\(this\.net\.mainnet\)return this\.v4KyberQuote\(item,body\);/); assert.match(wallet, /if\(this\.net\.mainnet\)return this\.v4KyberTrade\(item,body\);/);
  assert.match(wallet, /return \{ \.\.\.base, tokens, pairBalances \};/);
  const swap = readFileSync(new URL('../apps/web/swap-view.mjs', import.meta.url), 'utf8');
  assert.match(swap, /await Promise\.all\(\[from, to\]\.map\(balanceOf\)\); update\(\);/); assert.match(swap, /tokens\.slice\(0, 40\)/);
});
