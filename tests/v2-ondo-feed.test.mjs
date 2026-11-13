// Ondo stocks priced from Chainlink's underlying-share feed × Ondo's shares multiplier (Malik, 13 November: Ondo stocks
// on every EVM chain; BNB Chain has Chainlink feeds for 14 underlying shares but none for Ondo's tokens). The adapter
// answers price × sValue, refuses while Ondo pauses the token, and plugs into the V2 factory's feed-priced approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Fixture, launchV2, mined, v4Art } from './helpers/v2-fixture.mjs';

const WAD = 10n ** 18n, ceilDiv = (a, b) => (a + b - 1n) / b;

test('ElpidaOndoStockFeed: price × sValue, the underlying round, and a revert while Ondo pauses the token', async t => {
  const f = await v2Fixture(t), now = async () => (await f.provider.getBlock('latest')).timestamp;
  const underlying = await f.deploy(v4Art('MockUsdFeed'), 200n * 10n ** 8n), oracle = await f.deploy(v4Art('MockSharesOracle'));
  await assert.rejects(f.deploy(v4Art('ElpidaOndoStockFeed'), underlying.target, oracle.target, f.stock.target, 'mSTKon / USD'), /sValue/, 'a token Ondo does not price is refused');
  await mined(oracle.set(f.stock.target, 1_009_473_072_784_042_724n, false)); // SPYon's sValue on 13 November
  const feed = await f.deploy(v4Art('ElpidaOndoStockFeed'), underlying.target, oracle.target, f.stock.target, 'mSTKon / USD (Chainlink mSTK / USD x Ondo sValue)');
  assert.equal(await feed.decimals(), 8n); assert.equal(await feed.VERSION(), 1n);
  assert.match(await feed.description(), /^mSTKon \/ USD/);
  const [round, answer, , updatedAt, answered] = await feed.latestRoundData();
  assert.equal(answer, 200n * 10n ** 8n * 1_009_473_072_784_042_724n / WAD, '$200 × 1.00947');
  assert.equal(round, 1n); assert.equal(answered, 1n); assert.ok(updatedAt > 0n, 'the underlying round is passed through');
  await mined(oracle.set(f.stock.target, 1_009_473_072_784_042_724n, true));
  await assert.rejects(feed.latestRoundData(), e => e.data?.startsWith(feed.interface.getError('OndoPaused').selector) || /OndoPaused/.test(e.message));
  await mined(oracle.set(f.stock.target, 1_009_473_072_784_042_724n, false));
  await mined(underlying.set(0, await now(), 2, 2));
  await assert.rejects(feed.latestRoundData(), e => e.data?.startsWith(feed.interface.getError('BadAnswer').selector) || /BadAnswer/.test(e.message));
  await assert.rejects(f.deploy(v4Art('ElpidaOndoStockFeed'), underlying.target, oracle.target, f.stock.target, ''), /description/);
});

test('the V2 factory takes the adapter as a stock feed: the $20,000 start uses price × sValue, and an Ondo pause blocks launches', async t => {
  const f = await v2Fixture(t), now = async () => (await f.provider.getBlock('latest')).timestamp;
  const underlying = await f.deploy(v4Art('MockUsdFeed'), 400n * 10n ** 8n), oracle = await f.deploy(v4Art('MockSharesOracle'));
  await mined(oracle.set(f.stock.target, 125n * WAD / 100n, false)); // 1.25 shares per token: the token is worth $500
  const feed = await f.deploy(v4Art('ElpidaOndoStockFeed'), underlying.target, oracle.target, f.stock.target, 'mSTKon / USD');
  await mined(f.factory.connect(f.owner).approvePricedQuote(f.stock.target, feed.target, 4 * 86_400));
  assert.equal(await f.factory.quoteVirtual(f.stock.target), ceilDiv(20_000n * 5n * WAD * 10n ** 8n, 4n * 500n * 10n ** 8n), '$25,000 of virtual quote at $500 a token');
  await launchV2(f, { pair: 'stock', symbol: 'ONDO1' });
  await mined(oracle.set(f.stock.target, 125n * WAD / 100n, true));
  await assert.rejects(launchV2(f, { pair: 'stock', symbol: 'PAUSED' }));
  await mined(oracle.set(f.stock.target, 130n * WAD / 100n, false));
  await mined(underlying.set(400n * 10n ** 8n, await now(), 2, 2));
  assert.equal(await f.factory.quoteVirtual(f.stock.target), ceilDiv(20_000n * 5n * WAD * 10n ** 8n, 4n * 520n * 10n ** 8n), 'after the pause, the new multiplier prices the next launch');
  await launchV2(f, { pair: 'stock', symbol: 'ONDO2' });
});

test('scripts/ondo-stock-feeds.mjs: checks token, underlying feed and multiplier, deploys one adapter per stock, and the stock list accepts it', async t => {
  const { checkOndoFeeds, deployOndoFeeds, adaptedCandidates, adapterDescription } = await import('../scripts/ondo-stock-feeds.mjs');
  const { buildStockList } = await import('../packages/core/stock-list.mjs');
  const { Contract } = await import('ethers');
  const f = await v2Fixture(t), now = (await f.provider.getBlock('latest')).timestamp;
  const underlying = await f.deploy(v4Art('MockUsdFeed'), 250n * 10n ** 8n), oracle = await f.deploy(v4Art('MockSharesOracle'));
  await mined(underlying.setDescription('MSTK / USD')); await mined(oracle.set(f.stock.target, WAD, false));
  const entry = { symbol: 'mSTK', name: 'Mock stock', address: f.stock.target, underlyingFeed: underlying.target };
  const [ok] = await checkOndoFeeds({ provider: f.provider, sharesOracle: oracle.target, entries: [entry], now });
  assert.ok(ok.ok, JSON.stringify(ok)); assert.equal(ok.priceUsd, 250);
  await mined(underlying.setDescription('AAPL / USD'));
  const [wrong] = await checkOndoFeeds({ provider: f.provider, sharesOracle: oracle.target, entries: [entry], now });
  assert.match(wrong.reason, /not MSTK \/ USD/, 'a feed for another share is refused');
  await mined(underlying.setDescription('MSTK / USD'));
  const [badSymbol] = await checkOndoFeeds({ provider: f.provider, sharesOracle: oracle.target, entries: [{ ...entry, symbol: 'TSLAon' }], now });
  assert.match(badSymbol.reason, /symbol is mSTK/);
  const saved = [];
  const record = await deployOndoFeeds({ signer: f.signers[0], sharesOracle: oracle.target, entries: [entry], save: r => saved.push(structuredClone(r)) });
  assert.equal(saved.length, 1);
  const adapter = new Contract(record.feeds.mSTK.adapter, v4Art('ElpidaOndoStockFeed').abi, f.provider);
  assert.equal(await adapter.description(), adapterDescription('mSTK'));
  await deployOndoFeeds({ signer: f.signers[0], sharesOracle: oracle.target, entries: [entry], record, save: () => assert.fail('already deployed: nothing new') });
  const { list, rejected } = await buildStockList({ Contract, provider: f.provider, network: 'local', chainId: 31337, source: 'test', candidates: adaptedCandidates(record), now });
  assert.equal(rejected.length, 0, JSON.stringify(rejected)); assert.equal(list.stocks[0].feed, record.feeds.mSTK.adapter); assert.equal(list.stocks[0].priceUsd, 250);
});
