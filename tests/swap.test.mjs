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
  assert.deepEqual(swapTokens({ ...base, key: 'solana-mainnet' }, list), []);
  assert.equal(KYBER_CHAINS['robinhood-mainnet'], 'robinhood', 'Robinhood Chain swaps through Kyber too (24 November 2026)');
  assert.equal(KYBER_CHAINS['bnb-mainnet'], 'bsc');
  const arbitrum = { ...base, key: 'arbitrum-mainnet', chainId: 42161, payoutStable: { ...base.payoutStable, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' } };
  assert.equal(KYBER_CHAINS[arbitrum.key], 'arbitrum');
  assert.deepEqual(swapTokens(arbitrum).map(t => t.symbol), ['ETH', 'USDC']);
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

test('first-buy conversion: native → launch pair carries no Elpida fee; anything else with that purpose is refused', async () => {
  const { swapFeeFor } = await import('../apps/api/swap.mjs');
  const net = { ...base, v2: { shared: { treasury: '0x' + '7'.repeat(40) } } }, tokens = swapTokens(base, list), urls = [];
  const fetchImpl = async (url, init) => { urls.push({ url, body: init?.body });
    if (url.includes('/routes')) { const q = new URL(url).searchParams; return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: '1000', amountOut: '7' } } })); }
    return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, data: '0xab', transactionValue: '1000', amountOut: '7', amountIn: '1000' } })); };
  const swap = createSwap({ fetchImpl, tokensFor: () => tokens, feeFor: () => swapFeeFor(net, {}), launchPairsFor: () => [AAPL, base.payoutStable.address] });
  const q = await swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1000', purpose: 'first-buy' });
  assert.doesNotMatch(urls[0].url, /feeAmount/); assert.equal(q.fee, null);
  await swap.build({ network: 'base-mainnet', routeSummary: q.routeSummary, sender: '0x' + '1'.repeat(40), slippageBps: 100, purpose: 'first-buy' });
  await assert.rejects(swap.quote({ network: 'base-mainnet', tokenIn: AAPL, tokenOut: NATIVE, amountIn: '1000', purpose: 'first-buy' }), /between the native coin and the launch pair/, 'selling is not a first buy');
  await assert.rejects(swap.build({ network: 'base-mainnet', routeSummary: q.routeSummary, sender: '0x' + '1'.repeat(40), slippageBps: 100 }), /out of date/, 'a fee-free route cannot be built as an ordinary swap');
  const normal = await swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '1000' });
  assert.deepEqual(normal.fee, { bps: 50, side: 'in' }, 'ordinary swaps still pay 0.5%');
});

test('launch page: first buy can be paid in the native coin on mainnet V2, converted through KyberSwap first', () => {
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  assert.match(flow, /connected\(\) && \(!net\(\)\?\.mainnet \|\| v2Chosen\(\)\) && typeof ctx\.wallet\.firstBuyConversionQuote/);
  assert.match(flow, /net\(\)\?\.mainnet \? 'KyberSwap'/);
  const v2 = readFileSync(new URL('../apps/web/v2-launchpad.mjs', import.meta.url), 'utf8');
  assert.match(v2, /purpose=\$\{purpose\}/); assert.match(v2, /purpose = 'first-buy'/); assert.match(v2, /firstBuy = got > cap \? cap : got;/);
  assert.match(v2, /BigInt\(tx\.value \?\? '0'\) !== nativeIn/);
  assert.doesNotMatch(v2, /testnet-only for now/);
  const wallet = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(wallet, /testnet-only for now/); assert.match(wallet, /kyberFirstBuyQuote\(this\.net\.key, quoteAsset/);
});

test('token page native trades: purpose "pair" allows both directions between the native coin and a launch pair, fee-free', async () => {
  const tokens = swapTokens(base, list), urls = [];
  const fetchImpl = async url => { urls.push(url); const q = new URL(url).searchParams; return new Response(JSON.stringify({ data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: '5', amountOut: '9' } } })); };
  const swap = createSwap({ fetchImpl, tokensFor: () => tokens, feeFor: () => ({ bps: 50, receiver: '0x' + '7'.repeat(40) }), launchPairsFor: () => [AAPL] });
  await swap.quote({ network: 'base-mainnet', tokenIn: AAPL, tokenOut: NATIVE, amountIn: '5', purpose: 'pair' });
  await swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: AAPL, amountIn: '5', purpose: 'pair' });
  assert.ok(urls.every(u => !/feeAmount/.test(u)));
  await assert.rejects(swap.quote({ network: 'base-mainnet', tokenIn: NATIVE, tokenOut: tokens[1].address === AAPL ? tokens[2].address : '0x' + '5'.repeat(40), amountIn: '5', purpose: 'pair' }), /launch conversion|Unknown|not offered|Choose/i);
});

test('the network dollar keeps its own name in Swap (USDG on Robinhood Chain), USD Coin otherwise', () => {
  const usdg = swapTokens({ ...base, key: 'robinhood-mainnet', payoutStable: { address: base.payoutStable?.address ?? base.usd?.usdc, symbol: 'USDG', name: 'Global Dollar', decimals: 6 } }, list).find(t => t.kind === 'usdc');
  if (usdg) { assert.equal(usdg.symbol, 'USDG'); assert.equal(usdg.name, 'Global Dollar'); }
  const plain = swapTokens({ ...base, payoutStable: undefined }, list).find(t => t.kind === 'usdc');
  if (plain) { assert.equal(plain.symbol, 'USDC'); assert.equal(plain.name, 'USD Coin'); }
});
