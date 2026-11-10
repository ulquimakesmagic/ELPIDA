// Stocks priced at launch (Malik, 10 November, for 100+ stocks on mainnet): the V2 factory can approve a stock with its
// USD price feed instead of a fixed amount, so every stock launch starts at the same dollar market cap whatever the
// stock did since approval. A feed whose answer is invalid or too old blocks launches on that stock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, Wallet } from 'ethers';
import { v2Fixture, launchV2, mined, v4Art } from './helpers/v2-fixture.mjs';

const ceilDiv = (a, b) => (a + b - 1n) / b;

test('a feed-priced stock launches at the dollar starting market cap; stale or bad prices block it', async t => {
  const f = await v2Fixture(t), owner = f.owner, now = async () => (await f.provider.getBlock('latest')).timestamp;
  const feed = await f.deploy(v4Art('MockUsdFeed'), 180n * 10n ** 8n);
  assert.equal(await f.factory.STOCK_FEEDS_VERSION(), 1n);
  await assert.rejects(f.factory.connect(f.signers[1]).approveFeedQuote(f.stock.target, feed.target, 86_400), /quote approval/, 'treasury only');
  await assert.rejects(f.factory.connect(owner).approveFeedQuote(f.stock.target, feed.target, 5 * 86_400), /feed age/);
  await assert.rejects(f.factory.connect(owner).approveFeedQuote(f.stock.target, Wallet.createRandom().address, 86_400), /quote approval/, 'the feed must be a contract');
  await mined(f.factory.connect(owner).approveFeedQuote(f.stock.target, feed.target, 4 * 86_400));
  const q = await f.factory.quoteFeeds(f.stock.target);
  assert.equal(q.feed, feed.target); assert.equal(q.maxAge, 4n * 86_400n);
  await assert.rejects(f.factory.connect(owner).approveFeedQuote(f.stock.target, feed.target, 86_400), /quote approval/, 'once');
  await assert.rejects(f.factory.connect(owner).approveQuote(f.stock.target, parseEther('100')), /quote approval/, 'never both kinds');
  // $20,000 × 5/4 at $180 per share, in 18-decimal units.
  const at180 = ceilDiv(20_000n * 5n * 10n ** 18n * 10n ** 8n, 4n * 180n * 10n ** 8n);
  assert.equal(await f.factory.quoteVirtual(f.stock.target), at180);
  const first = await launchV2(f, { pair: 'stock', symbol: 'AT180' });
  assert.equal(first.launched.quote, f.stock.target);
  // The stock doubles: the next launch needs half as many shares for the same dollar start.
  await mined(feed.set(360n * 10n ** 8n, await now(), 2, 2));
  assert.equal(await f.factory.quoteVirtual(f.stock.target), ceilDiv(20_000n * 5n * 10n ** 18n * 10n ** 8n, 4n * 360n * 10n ** 8n));
  await launchV2(f, { pair: 'stock', symbol: 'AT360' });
  // Older than its limit (a long market closure): no launch until the feed updates.
  await mined(feed.set(360n * 10n ** 8n, (await now()) - 4 * 86_400 - 10, 3, 3));
  await assert.rejects(f.factory.quoteVirtual(f.stock.target), /stock price stale/);
  await assert.rejects(launchV2(f, { pair: 'stock', symbol: 'STALE' }), /stock price stale/);
  await mined(feed.set(0, await now(), 4, 4));
  await assert.rejects(launchV2(f, { pair: 'stock', symbol: 'ZERO' }), /stock price/);
  await mined(feed.set(360n * 10n ** 8n, await now(), 5, 4));
  await assert.rejects(f.factory.quoteVirtual(f.stock.target), /stock price/, 'an unanswered round is refused');
  // Fixed approvals and the native coin are unchanged.
  assert.ok(await f.factory.quoteVirtual(f.usdc.target) > 0n);
  assert.equal(await f.factory.quoteVirtual('0x0000000000000000000000000000000000000000'), await f.factory.nativeVirtualQuote());
  assert.equal(await f.factory.quoteVirtual(Wallet.createRandom().address), 0n);
});

import { Interface } from 'ethers';
import './helpers/browser-modules.mjs';
import { verifyStock, buildStockList, checkStockList, stockApprovalGroups, STOCK_LIST_SCHEMA } from '../packages/core/stock-list.mjs';
import { v4Artifacts } from '../apps/api/v4-artifacts.mjs';

/** A fake chain for the list checker: tokens and feeds by address. */
function fakeChain(now) {
  const A = n => '0x' + String(n).padStart(40, '0');
  const tokens = { [A(1)]: { symbol: 'TSLAon', decimals: 18 }, [A(2)]: { symbol: 'NVDAon', decimals: 18 }, [A(3)]: { symbol: 'SPYon', decimals: 2 }, [A(4)]: { symbol: 'AAPLon', decimals: 18 } };
  const feeds = { [A(11)]: { decimals: 8, description: 'TSLAon / USD', round: [5n, 25_000_000_000n, 0n, BigInt(now - 3600), 5n] }, [A(12)]: { decimals: 8, description: 'NVDA / USD', round: [7n, 18_000_000_000n, 0n, BigInt(now - 60), 7n] },
    [A(13)]: { decimals: 8, description: 'SPY / USD', round: [1n, 1n, 0n, BigInt(now), 1n] }, [A(14)]: { decimals: 8, description: 'MSFT / USD', round: [1n, 1n, 0n, BigInt(now), 1n] }, [A(15)]: { decimals: 8, description: 'AAPL / USD', round: [3n, 0n, 0n, BigInt(now), 3n] } };
  const provider = { getCode: async a => (tokens[a] || feeds[a] ? '0x60' : '0x') };
  class Contract { constructor(address) { const t = tokens[address], f = feeds[address]; Object.assign(this, { symbol: async () => t.symbol, decimals: async () => (t ?? f).decimals, description: async () => f.description, latestRoundData: async () => f.round }); } }
  return { A, provider, Contract };
}

test('the stock list keeps only stocks whose token and feed check out on chain', async () => {
  const now = 1_800_000_000, { A, provider, Contract } = fakeChain(now);
  assert.equal((await verifyStock({ Contract, provider, now }, { symbol: 'TSLAon', address: A(1), feed: A(11) })).stock.priceUsd, 250);
  const { list, rejected } = await buildStockList({ Contract, provider, network: 'ethereum', chainId: 1, source: 'Ondo addresses page + Chainlink Ondo GM feeds', now, candidates: [
    { symbol: 'TSLAon', name: 'Tesla', address: A(1), feed: A(11) },
    { symbol: 'NVDAon', address: A(2), feed: A(12) },
    { symbol: 'TSLAon', address: A(9), feed: A(11) },
    { symbol: 'SPYon', address: A(3), feed: A(13) },
    { symbol: 'MSFTon', address: A(4), feed: A(14) },
    { symbol: 'AAPLon', address: A(4), feed: A(15) },
    { symbol: 'NOPEon', address: A(8), feed: A(11) },
    { symbol: 'NVDAon', address: A(2), feed: A(12), maxAge: 9 * 86_400 },
  ] });
  assert.deepEqual(list.stocks.map(s => s.symbol), ['NVDAon', 'TSLAon']);
  assert.equal(list.schema, STOCK_LIST_SCHEMA); assert.equal(list.chainId, 1);
  const why = Object.fromEntries(rejected.map(r => [`${r.symbol}@${r.address}`, r.reason]));
  assert.equal(why[`TSLAon@${A(9)}`], 'duplicate');
  assert.match(why[`SPYon@${A(3)}`], /decimals 2/);
  assert.match(why[`MSFTon@${A(4)}`], /symbol is AAPLon/);
  assert.equal(why[`AAPLon@${A(4)}`], 'duplicate', 'one address cannot be two stocks');
  assert.match(why[`NOPEon@${A(8)}`], /no contract at the token/);
  assert.equal(rejected.length, 6);
  assert.throws(() => checkStockList(list, 56), /chain 1, not 56/);
  // 60 stocks → batches of 25, 25 and 10, skipping the approved ones.
  const many = { ...list, stocks: Array.from({ length: 62 }, (_, i) => ({ symbol: `S${i}on`, address: A(100 + i), feed: A(11), maxAge: 86_400 })) };
  const groups = stockApprovalGroups({ iface: new Interface(['function approveFeedQuote(address,address,uint256)']), factory: A(7), list: many, approved: new Set([A(100), A(101)].map(a => a.toLowerCase())) });
  assert.deepEqual(groups.map(g => g.length), [25, 25, 10]);
  assert.equal(groups[0][0].symbol, 'S2on');
});

test('the operator approves the verified list from the panel: directly on a test network, as Safe batches otherwise', async t => {
  const f = await v2Fixture(t), A = n => '0x' + String(n).padStart(40, '0');
  const feed = await f.deploy(v4Art('MockUsdFeed'), 180n * 10n ** 8n), feed2 = await f.deploy(v4Art('MockUsdFeed'), 90n * 10n ** 8n);
  const other = await f.deploy(v4Art('MockIssuerStock'));
  const list = { schema: STOCK_LIST_SCHEMA, network: 'base-sepolia', chainId: 31337, source: 'test', checkedAt: '2026-11-10T00:00:00.000Z', stocks: [
    { symbol: 'mSTK', address: f.stock.target, feed: feed.target, maxAge: 4 * 86_400 }, { symbol: 'mSTK2', address: other.target, feed: feed2.target, maxAge: 86_400 }] };
  const oldStorage = globalThis.localStorage, oldFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async url => String(url).startsWith('/api/public/stock-list') ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(list)) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(v4Artifacts())) };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.fetch = oldFetch; });
  const { v2StockListState, approveV2StockList } = await import('../apps/web/v2-launchpad.mjs');
  const net = { key: 'base-sepolia', name: 'Local', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target }, v2: { shared: { factory: f.factory.target, hook: f.hook.target, router: f.router.target } } };
  const wallet = signer => ({ net, provider: f.provider, signer, address: signer.address, onProgress() {}, async checkNetwork() {}, async wait(p) { const tx = await p; return { tx, receipt: await tx.wait() }; } });
  const before = await v2StockListState(wallet(f.owner));
  assert.deepEqual([before.listed, before.approved, before.feeds, before.groups.flat().length], [2, 0, true, 2]);
  // Someone other than the treasury: Safe Transaction Builder files, nothing sent.
  const safe = await approveV2StockList(wallet(f.signers[1]));
  assert.equal(safe.safeBatches.length, 1); assert.equal(safe.safeBatches[0].transactions.length, 2);
  assert.equal(safe.safeBatches[0].meta.createdFromSafeAddress, f.treasury);
  assert.equal((await v2StockListState(wallet(f.owner))).approved, 0);
  // The treasury itself (a test network): approved here, priced at launch from each feed.
  await approveV2StockList(wallet(f.owner));
  const after = await v2StockListState(wallet(f.owner));
  assert.deepEqual([after.approved, after.groups.length], [2, 0]);
  assert.equal((await f.factory.quoteFeeds(other.target)).feed, feed2.target);
  assert.match((await approveV2StockList(wallet(f.owner))).message, /All 2 listed stocks are already approved/);
  assert.ok(await f.factory.quoteVirtual(other.target) > 0n);
});
