// Ondo stocks priced by Pyth (Malik, 20 Nov 2026: every Ondo stock Pyth covers on BNB Chain, beyond Chainlink's 13).
// ElpidaPythOndoStockFeed answers Pyth's price × Ondo's sValue like a Chainlink feed and plugs into the V2 factory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder } from 'ethers';
import { v2Fixture, launchV2, mined, v4Art } from './helpers/v2-fixture.mjs';

const WAD = 10n ** 18n, ID = '0x' + 'ab'.repeat(32), ceilDiv = (a, b) => (a + b - 1n) / b;
const isError = (c, name) => e => e.data?.startsWith(c.interface.getError(name).selector) || new RegExp(name).test(e.message);

test('ElpidaPythOndoStockFeed: Pyth price to 8 decimals × sValue, publish time as the round, refusals', async t => {
  const f = await v2Fixture(t), now = async () => (await f.provider.getBlock('latest')).timestamp;
  const pyth = await f.deploy(v4Art('MockPyth')), oracle = await f.deploy(v4Art('MockSharesOracle'));
  const Feed = v4Art('ElpidaPythOndoStockFeed');
  await assert.rejects(f.deploy(Feed, pyth.target, ID, oracle.target, f.stock.target, 200, 'mSTKon / USD'), /sValue/, 'a token Ondo does not price is refused');
  await mined(oracle.set(f.stock.target, 1_003_908_000_000_000_000n, false));
  await assert.rejects(f.deploy(Feed, pyth.target, '0x' + '00'.repeat(32), oracle.target, f.stock.target, 200, 'x'), /price id/);
  await assert.rejects(f.deploy(Feed, pyth.target, ID, oracle.target, f.stock.target, 0, 'x'), /confidence/);
  const feed = await f.deploy(Feed, pyth.target, ID, oracle.target, f.stock.target, 200, 'mSTKon / USD (Pyth MSTK/USD x Ondo sValue)');
  assert.equal(await feed.decimals(), 8n); assert.equal(await feed.priceId(), ID); assert.equal(await feed.pyth(), pyth.target);
  await assert.rejects(feed.latestRoundData(), /PriceFeedNotFound|revert/, 'nothing stored in Pyth yet');
  const t0 = await now();
  await mined(pyth.set(ID, 34_321_000n, 20_000n, -5, t0)); // $343.21, ±$0.20, Pyth's equity exponent
  const [round, answer, startedAt, updatedAt, answered] = await feed.latestRoundData();
  assert.equal(answer, 34_321_000_000n * 1_003_908_000_000_000_000n / WAD, '$343.21 × 1.003908 at 8 decimals');
  assert.equal(updatedAt, BigInt(t0)); assert.equal(startedAt, BigInt(t0)); assert.equal(round, BigInt(t0)); assert.equal(answered, round);
  await mined(pyth.set(ID, 343n, 0n, 0, t0)); assert.equal((await feed.latestRoundData())[1], 343n * 10n ** 8n * 1_003_908_000_000_000_000n / WAD, 'exponent 0');
  await mined(pyth.set(ID, 34_321_000n, 700_000n, -5, t0));
  await assert.rejects(feed.latestRoundData(), isError(feed, 'WideConfidence'), 'confidence over 2% of the price');
  await mined(pyth.set(ID, -1n, 0n, -5, t0)); await assert.rejects(feed.latestRoundData(), isError(feed, 'BadAnswer'));
  await mined(pyth.set(ID, 1n, 0n, 2, t0)); await assert.rejects(feed.latestRoundData(), isError(feed, 'BadAnswer'), 'positive exponents refused');
  await mined(pyth.set(ID, 34_321_000n, 20_000n, -5, t0)); await mined(oracle.set(f.stock.target, WAD, true));
  await assert.rejects(feed.latestRoundData(), isError(feed, 'OndoPaused'));
});

test('the V2 factory takes it as a stock feed: $20,000 start at Pyth price × sValue; stale or paused blocks launches', async t => {
  const f = await v2Fixture(t), now = async () => (await f.provider.getBlock('latest')).timestamp;
  const pyth = await f.deploy(v4Art('MockPyth')), oracle = await f.deploy(v4Art('MockSharesOracle'));
  await mined(oracle.set(f.stock.target, 125n * WAD / 100n, false));
  const feed = await f.deploy(v4Art('ElpidaPythOndoStockFeed'), pyth.target, ID, oracle.target, f.stock.target, 200, 'mSTKon / USD');
  await mined(pyth.set(ID, 40_000_000n, 10_000n, -5, await now())); // $400 × 1.25 = $500 a token
  await mined(f.factory.connect(f.owner).approvePricedQuote(f.stock.target, feed.target, 4 * 86_400));
  assert.equal(await f.factory.quoteVirtual(f.stock.target), ceilDiv(20_000n * 5n * WAD * 10n ** 8n, 4n * 500n * 10n ** 8n));
  await launchV2(f, { pair: 'stock', symbol: 'PYTH1' });
  await mined(pyth.set(ID, 40_000_000n, 10_000n, -5, (await now()) - 5 * 86_400));
  await assert.rejects(f.factory.quoteVirtual(f.stock.target), /stock price stale/, 'older than the 4-day limit');
  // A newer signed update (the launch page pushes one) prices the next launch.
  const update = AbiCoder.defaultAbiCoder().encode(['bytes32', 'int64', 'uint64', 'int32', 'uint256'], [ID, 50_000_000n, 10_000n, -5, await now()]);
  await mined(pyth.updatePriceFeeds([update], { value: 1 }));
  assert.equal(await f.factory.quoteVirtual(f.stock.target), ceilDiv(20_000n * 5n * WAD * 10n ** 8n, 4n * 625n * 10n ** 8n), '$500 × 1.25');
  await launchV2(f, { pair: 'stock', symbol: 'PYTH2' });
  await mined(oracle.set(f.stock.target, 125n * WAD / 100n, true));
  await assert.rejects(launchV2(f, { pair: 'stock', symbol: 'PAUSED' }));
});

test('scripts/ondo-pyth-feeds.mjs: maps Ondo tickers to Pyth equity feeds, checks, pushes, deploys; the stock list accepts the adapters', async t => {
  const { mapPythFeeds, checkPythFeeds, pushPythPrices, deployPythFeeds, allFeedCandidates, pythDescription, MAX_CONF_BPS } = await import('../scripts/ondo-pyth-feeds.mjs');
  const { buildStockList } = await import('../packages/core/stock-list.mjs');
  const { Contract } = await import('ethers');
  const hermesFeeds = [
    { id: 'ab'.repeat(32), attributes: { symbol: 'Equity.US.AAPL/USD' } }, { id: 'cd'.repeat(32), attributes: { symbol: 'Equity.US.AAPL/USD.PRE' } },
    { id: 'ef'.repeat(32), attributes: { symbol: 'Equity.US.BRK-B/USD' } }, { id: '12'.repeat(32), attributes: { symbol: 'Equity.US.SPY/USD' } }];
  const tokens = [{ symbol: 'AAPLon', address: '0x' + '1'.repeat(40) }, { symbol: 'BRK.Bon', address: '0x' + '2'.repeat(40) }, { symbol: 'SPYon', address: '0x' + '3'.repeat(40), type: 'ETF' }, { symbol: 'ZZZon', address: '0x' + '4'.repeat(40) }];
  const { mapped, missing } = mapPythFeeds(tokens, hermesFeeds, { skip: new Set(['SPYon']) });
  assert.deepEqual(mapped.map(m => [m.symbol, m.pythId.slice(0, 6)]), [['AAPLon', '0xabab'], ['BRK.Bon', '0xefef']], 'regular-session feed only; BRK.B → BRK-B; Chainlink-priced skipped');
  assert.deepEqual(missing, ['ZZZon']);

  const f = await v2Fixture(t), now = (await f.provider.getBlock('latest')).timestamp;
  const pyth = await f.deploy(v4Art('MockPyth')), oracle = await f.deploy(v4Art('MockSharesOracle'));
  await mined(oracle.set(f.stock.target, WAD, false));
  const entry = { symbol: 'mSTK', name: 'Mock stock', address: f.stock.target, pythId: ID };
  const latest = new Map([[ID, { price: 25_000_000n, conf: 10_000n, expo: -5, publishTime: now }]]);
  const [ok] = await checkPythFeeds({ provider: f.provider, sharesOracle: oracle.target, pyth: pyth.target, entries: [entry], latest, now });
  assert.ok(ok.ok, JSON.stringify(ok)); assert.equal(ok.priceUsd, 250); assert.equal(ok.storedAgeSec, null, 'not stored in Pyth yet');
  const [wide] = await checkPythFeeds({ provider: f.provider, sharesOracle: oracle.target, pyth: pyth.target, entries: [entry], latest: new Map([[ID, { price: 100n, conf: 3n, expo: 0, publishTime: now }]]), now });
  assert.match(wide.reason, new RegExp(`wider than ${MAX_CONF_BPS / 100}%`));
  const [noPrice] = await checkPythFeeds({ provider: f.provider, sharesOracle: oracle.target, pyth: pyth.target, entries: [entry], latest: new Map(), now });
  assert.match(noPrice.reason, /no price/);

  const update = AbiCoder.defaultAbiCoder().encode(['bytes32', 'int64', 'uint64', 'int32', 'uint256'], [ID, 25_000_000n, 10_000n, -5, now]);
  const fetchImpl = async url => { assert.match(url, /^https:\/\/hermes\.pyth\.network\/v2\/updates\/price\/latest\?encoding=hex&parsed=true&ids\[\]=0xabab/); return new Response(JSON.stringify({ binary: { data: [update.slice(2)] }, parsed: [{ id: ID.slice(2), price: { price: '25000000', conf: '10000', expo: -5, publish_time: now } }] })); };
  const hashes = await pushPythPrices({ signer: f.signers[0], pyth: pyth.target, ids: [ID], fetchImpl });
  assert.equal(hashes.length, 1);

  const record = await deployPythFeeds({ signer: f.signers[0], pyth: pyth.target, sharesOracle: oracle.target, entries: [entry] });
  const adapter = new Contract(record.feeds.mSTK.adapter, v4Art('ElpidaPythOndoStockFeed').abi, f.provider);
  assert.equal(await adapter.description(), pythDescription('mSTK')); assert.equal(await adapter.maxConfBps(), BigInt(MAX_CONF_BPS));
  await deployPythFeeds({ signer: f.signers[0], pyth: pyth.target, sharesOracle: oracle.target, entries: [entry], record, save: () => assert.fail('already deployed') });
  const chainlink = { feeds: { mSTK: { symbol: 'mSTK', token: f.stock.target, adapter: '0x' + '9'.repeat(40) } } };
  assert.equal(allFeedCandidates(chainlink, record).length, 1, 'Chainlink wins where both exist');
  const candidates = allFeedCandidates(null, record);
  const { list, rejected } = await buildStockList({ Contract, provider: f.provider, network: 'local', chainId: 31337, source: 'test', candidates, now });
  assert.equal(rejected.length, 0, JSON.stringify(rejected)); assert.equal(list.stocks[0].feed, record.feeds.mSTK.adapter); assert.equal(list.stocks[0].priceUsd, 250);
});

test('launch page pushes a fresh Pyth price before a Pyth-priced stock launch, through the server relay', async () => {
  const page = readFileSync(new URL('../apps/web/v2-launchpad.mjs', import.meta.url), 'utf8');
  assert.match(page, /if \(pair === 'xstock'\) await refreshPythPrice\(w, factory, asset\);\n  const quote/);
  assert.match(page, /fetchImpl\(`\/api\/public\/pyth-update\?id=\$\{id\}`\)/);
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes("if(url.pathname==='/api/public/pyth-update')"));
  const { latestUpdate } = await import('../apps/api/pyth-hermes.mjs');
  await assert.rejects(latestUpdate(['nope']), /feed ids/);
});
