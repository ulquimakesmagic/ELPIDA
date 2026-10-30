// Testnet Ondo-style stock pair (contracts/evm/testnet/ElpidaTestOndoStock.sol, ElpidaTestStockFeed.sol,
// apps/web/test-stock.mjs). A token paired with tNVDAon behaves like the mainnet-fork NVDAon rehearsal
// (docs/ONDO_RESTRICTION_REHEARSAL.md): the test issuer's pause and blocklist halt transfers, nothing is lost, and
// trading resumes when they are lifted; the buy that graduates the curve waits for a usable stock price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, parseUnits } from 'ethers';
import './helpers/browser-modules.mjs';
import { compileContracts } from '../scripts/compile.mjs';
import { dexFixture, mined, art, FEE, TEST_URI } from './helpers/dex-fixture.mjs';
import { testStockStatus, testStockHold, TEST_STOCK_MAX_AGE_SEC } from '../apps/web/test-stock.mjs';
import { EVM_TEST_PAIRS } from '../packages/core/pairs.mjs';
import { EvmIndexer } from '../packages/indexer/evm-indexer.mjs';
import { stockCheck } from '../apps/web/token-insights.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');

const compiled = compileContracts();
const testArt = name => compiled[`contracts/evm/testnet/${name}.sol`][name];

test('stock status: fresh, closed, stale, corporate action, paused and outage, and what each one holds', () => {
  const now = 1_800_000_000, fresh = { provider: 'ondo-test', paused: false, price: '180', updatedAt: now - 60, marketStatus: 'open' };
  assert.deepEqual(testStockStatus(fresh, now), { status: 'fresh', usable: true, age: 60, reason: null });
  assert.equal(testStockStatus({ ...fresh, marketStatus: 'closed' }, now).status, 'fresh', 'a fresh price is usable even when the market is closed');
  const old = { ...fresh, updatedAt: now - TEST_STOCK_MAX_AGE_SEC - 1 };
  assert.equal(testStockStatus(old, now).status, 'stale');
  assert.equal(testStockStatus({ ...old, marketStatus: 'closed' }, now).status, 'market-closed');
  assert.equal(testStockStatus({ ...fresh, marketStatus: 'corporate-action' }, now).status, 'corporate-action', 'a fresh price does not clear a corporate action');
  assert.equal(testStockStatus({ ...fresh, paused: true, marketStatus: 'corporate-action' }, now).status, 'paused', 'a pause outranks everything');
  for (const bad of [{ price: '0' }, { price: 'x' }, { updatedAt: now + 301 }]) assert.equal(testStockStatus({ ...fresh, ...bad }, now).status, 'outage');
  assert.deepEqual(testStockStatus({ ...fresh, updatedAt: now + 30 }, now), { status: 'fresh', usable: true, age: 0, reason: null }, 'a block clock slightly ahead is not an outage');
  assert.equal(testStockStatus(null, now), null);

  // Holds: a pause or a blocked wallet stops every action; a bad price only stops the graduating buy.
  assert.match(testStockHold({ ...fresh, paused: true }, { action: 'sell' }, now), /paused/);
  assert.match(testStockHold(fresh, { action: 'withdraw', blocked: true }, now), /blocklist/);
  assert.equal(testStockHold(old, { action: 'buy', completes: false }, now), null, 'ordinary curve buys continue on a stale price');
  assert.match(testStockHold(old, { action: 'buy', completes: true }, now), /^This buy would complete the curve and graduate it, but the stock price is older/);
  assert.equal(testStockHold(fresh, { action: 'buy', completes: true }, now), null);
  assert.equal(testStockHold(undefined, { action: 'buy', completes: true }, now), null, 'other pairs are untouched');

  // The token page's safety line.
  assert.deepEqual(stockCheck({ quoteSymbol: 'tNVDAon', stock: fresh }, now), { ok: true, text: 'Paired with tNVDAon, a test stand-in for an Ondo stock (Ondo (test stand-in)): the issuer can pause it or block wallets. Stock price $180, fresh.' });
  assert.equal(stockCheck({ quoteSymbol: 'tNVDAon', stock: { ...fresh, marketStatus: 'corporate-action' } }, now).ok, false);
  assert.equal(stockCheck({ quoteSymbol: 'TEST-STOCK' }, now), null);
  // The pair the treasury deploys.
  const pair = EVM_TEST_PAIRS.find(p => p.key === 'test-ondo-nvda');
  assert.equal(pair.symbol, 'tNVDAon'); assert.equal(pair.kind, 'xstock'); assert.ok(pair.ondo.feed && Number(pair.ondo.price) > 0);
});

async function stockPair(t) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' });
  const feed = await f.deploy(testArt('ElpidaTestStockFeed'), 'tNVDAon / USD (test total-return)', parseUnits('180', 8));
  const stock = await f.deploy(testArt('ElpidaTestOndoStock'), 'Elpida test Ondo-style NVDA stock (no value)', 'tNVDAon', 25n, feed.target);
  const adapter = await f.deploy(art('ElpidaV3MigrationAdapter'), f.dex.manager.target, stock.target, 10000);
  const virtualQuote = parseUnits('20', 18) * await f.factory.VIRTUAL_TOKEN() / await f.factory.TOKEN_SUPPLY();
  await mined(f.factory.connect(f.signers[2]).approveQuote(stock.target, virtualQuote, adapter.target));
  const receipt = await mined(f.factory.connect(f.signers[0]).launchPairedWithMetadata('Stock Paired', 'SPAIR', stock.target, 0n, 0n, f.addresses[0], TEST_URI, { value: FEE }));
  const ev = receipt.logs.map(l => { try { return f.factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
  const curve = new (await import('ethers')).Contract(ev.args.curve, art('ElpidaDexCurve').abi, f.signers[1]);
  const trader = f.signers[1];
  for (let i = 0; i < 4; i++) await mined(stock.connect(trader).faucet(parseUnits('25', 18)));
  await mined(stock.connect(trader).approve(curve.target, 2n ** 256n - 1n));
  return { f, feed, stock, curve, trader, token: ev.args.token };
}

test('the test issuer pause and blocklist halt the curve without losing anything, and trading resumes after', async t => {
  const { f, feed, stock, curve, trader } = await stockPair(t);
  assert.equal(await stock.stockProvider(), 'ondo-test'); assert.equal(await stock.pairKind(), 'xstock');
  assert.equal(await stock.referenceFeed(), feed.target); assert.equal(await stock.controller(), f.addresses[0]);
  const launched = Number(await curve.launchedAt()), now = await f.now(); if (now < launched + 61) await f.advance(launched + 61 - now);
  await mined(curve.buy(parseUnits('2', 18), 0n));
  const reserve = await curve.realReserve(), held = await stock.balanceOf(trader.address);

  await mined(stock.setPaused(true));
  await assert.rejects(curve.buy(parseUnits('1', 18), 0n), /token paused/);
  await assert.rejects(stock.connect(trader).faucet(1n), /token paused/, 'even the faucet waits');
  assert.equal(await curve.realReserve(), reserve, 'nothing moved while paused');
  assert.equal(await stock.balanceOf(trader.address), held);
  await mined(stock.setPaused(false));

  await mined(stock.setBlocked(trader.address, true));
  await assert.rejects(curve.buy(parseUnits('1', 18), 0n), /account blocked/);
  await assert.rejects(stock.connect(trader).transfer(f.addresses[3], 1n), /account blocked/);
  await mined(stock.setBlocked(trader.address, false));
  await mined(curve.buy(parseUnits('1', 18), 0n));
  assert.ok(await curve.realReserve() > reserve, 'trading resumed');

  // Only the test issuer controls the stock and its feed.
  await assert.rejects(stock.connect(trader).setPaused(true), /NotController|reverted/);
  await assert.rejects(feed.connect(trader).post(1n), /NotController|reverted/);
  await assert.rejects(feed.setMarketStatus(3), /InvalidStatus|reverted/);
  await assert.rejects(feed.post(0n), /InvalidAnswer|reverted/);
});

test('the indexer reads the stock state, the wallet stops before signing, and a fresh price graduates the curve', async t => {
  const { f, feed, stock, curve, trader } = await stockPair(t);
  const read = () => EvmIndexer.prototype.stockSnapshot.call({ provider: f.provider }, stock.target, { blockTag: 'latest' });
  let snap = await read();
  assert.deepEqual({ ...snap, updatedAt: typeof snap.updatedAt }, { provider: 'ondo-test', paused: false, feed: feed.target.toLowerCase(), description: 'tNVDAon / USD (test total-return)', price: '180.0', updatedAt: 'number', marketStatus: 'open' });
  assert.equal(await EvmIndexer.prototype.stockSnapshot.call({ provider: f.provider }, f.usdc.target, { blockTag: 'latest' }), null, 'other quote assets have no stock record');
  await mined(feed.setMarketStatus(2)); await mined(feed.post(parseUnits('181.5', 8)));
  snap = await read();
  assert.equal(snap.marketStatus, 'corporate-action'); assert.equal(snap.price, '181.5');
  assert.equal(testStockStatus(snap, snap.updatedAt).status, 'corporate-action');

  // The wallet's preflight against the real contracts.
  const wallet = Object.create(TestnetWallet.prototype);
  Object.assign(wallet, { provider: f.provider, address: trader.address, config: { contracts: { testOndoStock: { abi: testArt('ElpidaTestOndoStock').abi }, testStockFeed: { abi: testArt('ElpidaTestStockFeed').abi } } } });
  const item = { pair: 'xstock', quoteAddress: stock.target };
  const launched = Number(await curve.launchedAt()), now = await f.now(); if (now < launched + 61) await f.advance(launched + 61 - now);
  await wallet.stockPreflight(item, 'buy', { input: parseUnits('1', 18), curve }); // an ordinary buy proceeds during a corporate action
  const completing = await curve.completionQuote();
  await assert.rejects(wallet.stockPreflight(item, 'buy', { input: completing, curve }), /would complete the curve.*corporate action/s, 'the graduating buy waits');
  await mined(stock.setBlocked(trader.address, true));
  await assert.rejects(wallet.stockPreflight(item, 'sell'), /blocklist/);
  await mined(stock.setBlocked(trader.address, false)); await mined(stock.setPaused(true));
  await assert.rejects(wallet.stockPreflight(item, 'withdraw'), /paused/);
  await mined(stock.setPaused(false));
  await wallet.stockPreflight({ pair: 'usdc', quoteAddress: f.usdc.target }, 'buy', { input: 1n, curve }); // not a stock pair

  // Corporate action over, fresh price: the completing buy passes the gate and graduates into the pool.
  await mined(feed.setMarketStatus(0)); await mined(feed.post(parseUnits('182', 8)));
  const gross = await curve.completionQuote();
  for (let i = 0; i < 4 && await stock.balanceOf(trader.address) < gross; i++) await mined(stock.connect(trader).faucet(parseUnits('25', 18)));
  await wallet.stockPreflight(item, 'buy', { input: gross, curve });
  await mined(curve.buy(gross, 0n));
  assert.notEqual(await curve.pool(), ZeroAddress, 'graduated into the pool, paired with the test stock');
});
