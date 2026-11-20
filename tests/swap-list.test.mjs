// Swap-only lists (Malik, 20 Nov 2026): every Ondo stock and ETF on BNB Chain in Swap, no price feed needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSwapList, SWAP_LIST_SCHEMA } from '../packages/core/swap-list.mjs';
import { swapTokens, NATIVE } from '../apps/api/swap.mjs';

const A = n => '0x' + String(n).repeat(40).slice(0, 40);
const chain = { '0x1111111111111111111111111111111111111111': ['AAPLon', 18], '0x2222222222222222222222222222222222222222': ['SPYon', 18], '0x3333333333333333333333333333333333333333': ['WRONG', 18], '0x4444444444444444444444444444444444444444': ['BIGon', 30] };
const provider = { getCode: async a => (chain[a] ? '0x60' : '0x') };
class Contract { constructor(a) { this.a = a; } async symbol() { return chain[this.a][0]; } async decimals() { return chain[this.a][1]; } }

test('build: on-chain symbol and decimals checked; duplicates, missing code and odd decimals rejected', async () => {
  const candidates = [
    { symbol: 'AAPLon', name: 'Apple (Ondo)', address: A(1), type: 'Stock' }, { symbol: 'SPYon', name: 'SPDR S&P 500 (Ondo)', address: A(2), type: 'ETF' },
    { symbol: 'AAPLon', address: A(1) }, { symbol: 'Xon', address: A(3) }, { symbol: 'BIGon', address: A(4) }, { symbol: 'NOPEon', address: A(5) }];
  const { list, rejected } = await buildSwapList({ Contract, provider, network: 'bnb-mainnet', chainId: 56, source: 't', candidates });
  assert.equal(list.schema, SWAP_LIST_SCHEMA); assert.deepEqual(list.tokens.map(t => t.symbol), ['AAPLon', 'SPYon']); assert.equal(list.tokens[1].type, 'ETF');
  assert.deepEqual(rejected.map(r => r.reason.split(' ')[0]), ['duplicate', 'the', 'unsupported', 'no']);
});

test('swap tokens: launch stocks first, swap-only tokens added once, other chains ignored', () => {
  const net = { key: 'bnb-mainnet', chainId: 56, nativeCurrency: { symbol: 'BNB' }, payoutStable: { address: A(9), symbol: 'USDC', decimals: 18 } };
  const stockList = { stocks: [{ symbol: 'AAPLon', name: 'Apple (Ondo)', address: A(1), decimals: 18 }] };
  const swapList = { chainId: 56, tokens: [{ symbol: 'AAPLon', address: A(1), decimals: 18 }, { symbol: 'SPYon', name: 'SPDR (Ondo)', address: A(2), decimals: 18 }] };
  const t = swapTokens(net, stockList, swapList);
  assert.deepEqual(t.map(x => x.symbol), ['BNB', 'USDC', 'AAPLon', 'SPYon']); assert.equal(t[0].address, NATIVE); assert.equal(t[3].kind, 'xstock', 'region block applies');
  assert.equal(swapTokens(net, stockList, { ...swapList, chainId: 1 }).length, 3);
});

test('BNB candidates: 474 Ondo stocks and ETFs from Ondo\'s list, including the 13 launch candidates at the same addresses', () => {
  const all = JSON.parse(readFileSync(new URL('../config/stocks/candidates/bnb-ondo-all.json', import.meta.url), 'utf8'));
  const launch = JSON.parse(readFileSync(new URL('../config/stocks/candidates/bnb-ondo-underlying.json', import.meta.url), 'utf8'));
  assert.equal(all.length, 474); assert.ok(all.every(c => /on$/.test(c.symbol) && /^0x[0-9a-fA-F]{40}$/.test(c.address)));
  for (const c of launch) assert.equal(all.find(a => a.symbol === c.symbol)?.address.toLowerCase(), c.address.toLowerCase(), c.symbol);
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('swapTokens(n,stockListFor(key),swapListFor(key))'));
});
