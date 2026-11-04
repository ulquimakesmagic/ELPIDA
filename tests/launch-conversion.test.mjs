// Creator first purchase paid in the native coin on a non-native pair: convert once, reuse on retries, and seed
// testnet conversion pools at the feed price (apps/web/launch-conversion.mjs, scripts/seed-conversion-pools.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertForLaunch, deliveredBy, pendingConversion, conversionKey, SWAP_TOPICS } from '../apps/web/launch-conversion.mjs';
import { conversionPoolPlan, sqrtInteger } from '../scripts/lib/conversion-pool-plan.mjs';

const addr = n => '0x' + String(n).padStart(40, '0');
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), m }; };
const ASSET = addr(5), WETH = addr(4), POOL = addr(7), ME = addr(9), KEY = 'k';
const word = v => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, '0');
// The asset (…05) sorts after WETH (…04), so it is token1: the pool pays it out as a negative amount1.
const swap = (to, out, { pool = POOL, kind = 0 } = {}) => ({ address: pool, topics: [SWAP_TOPICS[kind], topic(addr(1)), topic(to)], data: '0x' + word(10n ** 15n) + word(-out) + word(1n) + word(1n) + word(1n) });
const ROUTE = { pool: POOL, tokenIn: WETH, minimum: 90n };

function chain({ latest = 10, pending = 10, logs = [] } = {}) {
  const state = { latest, pending, sent: 0 };
  return { state, provider: { getTransactionCount: async (_, tag) => tag === 'latest' ? state.latest : state.pending, getBlockNumber: async () => 100, getLogs: async () => logs } };
}

test('a fresh conversion records its intent, then the amount the pool delivered', async () => {
  const s = storage(), { provider, state } = chain();
  const result = await convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, quote: async () => ROUTE,
    send: async () => { state.sent++; assert.equal(JSON.parse(s.getItem(KEY)).intent, true); return { hash: '0xabc', wait: async () => ({ status: 1, logs: [swap(ME, 95n), swap(ME, 1000n, { pool: addr(6) }), swap(addr(8), 5n)] }) }; } });
  assert.deepEqual(result, { amount: 95n, reused: false, hash: '0xabc' });
  assert.equal(pendingConversion(s, KEY), 95n);
  // A failed launch leaves the record; the next press reuses it without a second swap.
  const again = await convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, quote: async () => assert.fail('no new quote'), send: async () => assert.fail('no second swap') });
  assert.deepEqual(again, { amount: 95n, reused: true, hash: '0xabc' });
  assert.equal(state.sent, 1);
});

test('a wallet that signed but never answered: the delivered amount is found on chain and reused', async () => {
  const s = storage(); s.setItem(KEY, JSON.stringify({ intent: true, nonce: 10, block: 99, pool: POOL, assetIsToken0: false, at: Date.now() }));
  const { provider } = chain({ latest: 11, logs: [swap(ME, 42n, { kind: 1 })] });
  const result = await convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, quote: async () => assert.fail('no quote'), send: async () => assert.fail('no swap') });
  assert.deepEqual(result, { amount: 42n, reused: true, hash: null });
});

test('a conversion still in flight blocks a second one; a dropped one reopens after three minutes', async () => {
  const s = storage(), at = 1_000_000; s.setItem(KEY, JSON.stringify({ intent: true, nonce: 10, block: 99, pool: POOL, at }));
  const { provider } = chain({ latest: 10 });
  await assert.rejects(convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, now: () => at + 60_000, quote: async () => assert.fail(), send: async () => assert.fail() }), /may still be sending/);
  let sent = 0;
  const result = await convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, now: () => at + 200_000, quote: async () => ROUTE,
    send: async () => { sent++; return { hash: '0xdef', wait: async () => ({ status: 1, logs: [swap(ME, 7n)] }) }; } });
  assert.equal(result.amount, 7n); assert.equal(sent, 1);
});

test('a nonce used by something else, a rejected signature or a failed swap leaves nothing recorded', async () => {
  const s = storage(); s.setItem(KEY, JSON.stringify({ intent: true, nonce: 10, block: 99, pool: POOL, at: Date.now() }));
  const { provider } = chain({ latest: 11, logs: [] });
  await assert.rejects(convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, quote: async () => ROUTE, send: async () => { throw Object.assign(new Error('user rejected'), { code: 4001 }); } }), /rejected/);
  assert.equal(s.getItem(KEY), null);
  await assert.rejects(convertForLaunch({ provider, storage: s, key: KEY, account: ME, asset: ASSET, quote: async () => ROUTE, send: async () => ({ hash: '0x1', wait: async () => ({ status: 0, logs: [] }) }) }), /did not succeed/);
  assert.equal(s.getItem(KEY), null);
  assert.equal(deliveredBy([swap(ME, 3n, { pool: addr(6) })], { pool: POOL, account: ME, assetIsToken0: false }), 0n, 'another pool is not the conversion');
  assert.equal(deliveredBy([swap(ME, 3n)], { pool: POOL, account: ME, assetIsToken0: true }), 0n, 'the side the pool received is not delivered');
  assert.match(conversionKey({ chainId: 97, factory: '0xAB', account: '0xCD', asset: '0xEF' }), /^elpida:launch-conversion:v1:97:0xab:0xcd:0xef$/);
});

test('seed plans price the pool at the feeds and use full-range ticks on the tier spacing', () => {
  const weth = '0x' + 'f'.repeat(40), stock = addr(1);
  const plan = conversionPoolPlan({ nativeAmount: 2n * 10n ** 16n, nativeUsd8: 3000n * 10n ** 8n, stockUsd8: 180n * 10n ** 8n, asset: stock, weth, spacing: 200 });
  assert.equal(plan.stockAmount, 2n * 10n ** 16n * 3000n / 180n);
  assert.equal(plan.token0, stock); assert.equal(plan.amount0, plan.stockAmount);
  assert.equal(plan.tickUpper, 887200); assert.equal(plan.tickLower, -887200);
  // price = amount1/amount0 = native per stock = 180/3000
  const price = Number(plan.sqrtPriceX96) ** 2 / 2 ** 192; assert.ok(Math.abs(price - 0.06) < 1e-9);
  assert.equal(conversionPoolPlan({ nativeAmount: 1n, nativeUsd8: 1n, stockUsd8: 1n, asset: weth, weth: stock, spacing: 50 }).tickUpper, 887250);
  assert.throws(() => conversionPoolPlan({ nativeAmount: 2n * 10n ** 18n, nativeUsd8: 1n, stockUsd8: 1n, asset: stock, weth, spacing: 200 }), /at most|between/i);
  assert.equal(sqrtInteger(10n ** 36n), 10n ** 18n);
});

test('real V3: a native conversion delivers the pair asset and the recorded amount matches the wallet', async t => {
  const { Contract, Interface, parseEther } = await import('ethers');
  const { dexFixture, mined } = await import('./helpers/dex-fixture.mjs');
  const { swapCalldata } = await import('../packages/core/dex-router.mjs');
  const { quoteNativePairConversion } = await import('../apps/web/usdc-conversion.mjs');
  const f = await dexFixture(t), signer = f.signers[0], owner = f.addresses[0], d = f.dex;
  const amount = parseEther('2'); await mined(d.weth.connect(signer).deposit({ value: amount })); await mined(f.usdc.mint(owner, amount));
  for (const coin of [d.weth, f.usdc]) await mined(coin.connect(signer).approve(d.manager.target, amount));
  const [token0, token1] = [d.weth.target, f.usdc.target].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  await mined(d.manager.createAndInitializePoolIfNecessary(token0, token1, 10000, 2n ** 96n));
  const deadline = BigInt(await f.now() + 300);
  await mined(d.manager.mint({ token0, token1, fee: 10000, tickLower: -887200, tickUpper: 887200, amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0, recipient: owner, deadline }));
  const s = storage(), before = await f.usdc.balanceOf(owner), nativeBuy = parseEther('0.01');
  const result = await convertForLaunch({ provider: f.provider, storage: s, key: KEY, account: owner, asset: f.usdc.target,
    quote: () => quoteNativePairConversion({ Contract, provider: f.provider, dex: d.config, asset: f.usdc.target, amountIn: nativeBuy }),
    send: async route => signer.sendTransaction({ to: d.router.target, value: nativeBuy, data: swapCalldata(Interface, 2, d.router.target, { tokenIn: route.tokenIn, tokenOut: route.tokenOut, fee: route.fee, recipient: owner, amountIn: nativeBuy, amountOutMinimum: route.minimum }, { deadline, refundETH: true }) }) });
  assert.equal(result.amount, await f.usdc.balanceOf(owner) - before);
  assert.ok(result.amount > 0n && !result.reused);
  // The same amount is found from the chain alone, as after a wallet that never answered.
  const s2 = storage(); s2.setItem(KEY, JSON.stringify({ intent: true, nonce: (await f.provider.getTransactionCount(owner, 'latest')) - 1, block: 0, assetIsToken0: token0 === f.usdc.target, pool: (await new Contract(d.factory.target, ['function getPool(address,address,uint24) view returns(address)'], f.provider).getPool(token0, token1, 10000)), at: Date.now() }));
  const found = await convertForLaunch({ provider: f.provider, storage: s2, key: KEY, account: owner, asset: f.usdc.target, quote: async () => assert.fail(), send: async () => assert.fail() });
  assert.equal(found.amount, result.amount);
});
