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

test('fee: 0.5% default to the treasury Safe, native/USDC side, enforced at build', async () => {
  const { swapFeeFor, feeSide } = await import('../apps/api/swap.mjs');
  const treasury = '0x' + '7'.repeat(40), net = { ...base, v2: { shared: { treasury } } };
  assert.deepEqual(swapFeeFor(net, {}), { bps: 50, receiver: treasury });
  assert.equal(swapFeeFor(net, { ELPIDA_SWAP_FEE_BPS: '0' }), null);
  assert.equal(swapFeeFor(net, { ELPIDA_SWAP_FEE_BPS: '500' }).bps, 100, 'capped at 1%');
  assert.equal(swapFeeFor(base, {}), null, 'no treasury, no fee');
  const tokens = swapTokens(base, list);
  assert.equal(feeSide(tokens, NATIVE), 'currency_in'); assert.equal(feeSide(tokens, tokens[1].address), 'currency_in'); assert.equal(feeSide(tokens, AAPL), 'currency_out');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init });
    if (url.includes('/routes')) { const q = new URL(url).searchParams; return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: '1000', amountOut: '5', extraFee: { feeAmount: q.get('feeAmount'), chargeFeeBy: q.get('chargeFeeBy'), isInBps: q.get('isInBps') === 'true', feeReceiver: q.get('feeReceiver') } } } })); }
    return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, data: '0xab', transactionValue: '0', amountOut: '5', amountIn: '1000' } })); };
  const swap = createSwap({ fetchImpl, tokensFor: () => tokens, feeFor: () => swapFeeFor(net, {}) });
  const q = await swap.quote({ network: 'base-mainnet', tokenIn: AAPL, tokenOut: NATIVE, amountIn: '1000' });
  assert.match(calls[0].url, /feeAmount=50&isInBps=true&chargeFeeBy=currency_out&feeReceiver=0x7{40}/); assert.deepEqual(q.fee, { bps: 50, side: 'out' });
  const sender = '0x' + '1'.repeat(40);
  await swap.build({ network: 'base-mainnet', routeSummary: q.routeSummary, sender, slippageBps: 100 });
  await assert.rejects(swap.build({ network: 'base-mainnet', routeSummary: { ...q.routeSummary, extraFee: { feeAmount: '0', chargeFeeBy: '', isInBps: false, feeReceiver: '' } }, sender, slippageBps: 100 }), /out of date/);
  await assert.rejects(swap.build({ network: 'base-mainnet', routeSummary: { ...q.routeSummary, extraFee: { ...q.routeSummary.extraFee, feeReceiver: sender } }, sender, slippageBps: 100 }), /out of date/);
});

test('page: 25/50/Max portions keep a gas reserve on the native coin', async () => {
  const { portionOf } = await import('../apps/web/swap-view.mjs');
  assert.equal(portionOf(1000n, 25), 250n); assert.equal(portionOf(1000n, 100), 1000n);
  assert.equal(portionOf(1000n, 100, { native: true, reserve: 200n }), 800n);
  assert.equal(portionOf(1000n, 50, { native: true, reserve: 200n }), 500n);
  assert.equal(portionOf(100n, 100, { native: true, reserve: 200n }), 0n);
});
