// Swap page (Malik, 20 November 2026): native coin, USDC and the network's stocks, routed by KyberSwap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSwap, swapTokens, KYBER_ROUTER, KYBER_CHAINS, NATIVE } from '../apps/api/swap.mjs';
import './helpers/browser-modules.mjs';

const base = { key: 'base-mainnet', mainnet: true, nativeCurrency: { symbol: 'ETH', name: 'Ether' }, payoutStable: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 } };
const list = JSON.parse(readFileSync(new URL('../config/stocks/base-mainnet.json', import.meta.url), 'utf8'));
const AAPL = list.stocks[0].address;

test('tokens: native, USDC and the verified stocks; only Kyber chains', () => {
  const t = swapTokens(base, list);
  assert.equal(t[0].address, NATIVE); assert.equal(t[1].symbol, 'USDC'); assert.equal(t.filter(x => x.kind === 'xstock').length, list.stocks.length);
  assert.deepEqual(swapTokens({ ...base, key: 'robinhood-mainnet' }, list), []);
  assert.equal(KYBER_CHAINS['bnb-mainnet'], 'bsc');
});

test('quote and build: offered tokens only, Kyber router only, slippage bounds', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init });
    if (url.includes('/routes')) return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1000', amountOut: '5', gasUsd: '0.01' } } }));
    return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, data: '0xabcdef', transactionValue: '1000', amountOut: '5', amountIn: '1000' } })); };
  const swap = createSwap({ fetchImpl, tokensFor: k => k === 'base-mainnet' ? swapTokens(base, list) : [] });
  const q = await swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1000' });
  assert.equal(q.amountOut, '5'); assert.match(calls[0].url, /^https:\/\/aggregator-api\.kyberswap\.com\/base\/api\/v1\/routes\?/); assert.equal(calls[0].init.headers['x-client-id'], 'elpida');
  await assert.rejects(swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: '0x' + '9'.repeat(40), amountIn: '1' }), /two different assets/);
  await assert.rejects(swap.quote({ network: 'base-sepolia', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1' }), /not available/);
  await assert.rejects(swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '0' }), /amount/);
  const b = await swap.build({ network: 'base-mainnet', routeSummary: q.routeSummary, sender: '0x' + '1'.repeat(40), slippageBps: 100 });
  assert.equal(b.to, KYBER_ROUTER); assert.equal(b.value, '1000');
  const sent = JSON.parse(calls.at(-1).init.body); assert.equal(sent.recipient, sent.sender); assert.equal(sent.slippageTolerance, 100);
  await assert.rejects(swap.build({ network: 'base-mainnet', routeSummary: q.routeSummary, sender: '0x' + '1'.repeat(40), slippageBps: 900 }), /Slippage/);
  const evil = createSwap({ fetchImpl: async () => new Response(JSON.stringify({ data: { routerAddress: '0x' + '6'.repeat(40), routeSummary: {} } })), tokensFor: () => swapTokens(base, list) });
  await assert.rejects(evil.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1' }), /Unexpected swap router/);
});

test('page: units parsing, router pinned, nav and route wired', async () => {
  const { toUnits, KYBER_ROUTER: pinned } = await import('../apps/web/swap-view.mjs');
  assert.equal(pinned, KYBER_ROUTER);
  assert.equal(toUnits('1.5', 6), 1500000n); assert.equal(toUnits('0', 6), null); assert.equal(toUnits('abc', 6), null); assert.equal(toUnits('1.1234567', 6), null);
  const html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="#\/swap" class="dock-link" aria-label="Swap" data-nav="swap"/);
  const app = readFileSync(new URL('../apps/web/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /swap: \(\) => import\('\.\/swap-view\.mjs'\)/); assert.match(app, /'\/swap': 'swap'/);
  const page = readFileSync(new URL('../apps/web/swap-view.mjs', import.meta.url), 'utf8');
  assert.match(page, /if \(!same\(tx\.to, KYBER_ROUTER\)\) throw/);
  assert.match(page, /token\.approve\(KYBER_ROUTER, units\)/, 'approves exactly the input');
});
