// Robinhood Chain testnet has no Uniswap v3 and no Chainlink feed. This runs, on a local chain, the whole path a
// launchpad owner takes there: the site deploys the labelled test DEX and an ElpidaRelayFeed from the owner's wallet;
// the server relay copies Chainlink rounds into the feed with Chainlink's own timestamps; once registered, the normal
// launchpad setup prices launches with that feed, and a completed curve graduates into the test Uniswap v3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, Wallet, ZeroAddress, parseEther } from 'ethers';
import './helpers/browser-modules.mjs';
import { dexFixture, mined, art, fixtureArt, launch, complete } from './helpers/dex-fixture.mjs';
import { testDexArtifacts } from '../apps/api/test-dex-artifacts.mjs';
import { FeedRelay } from '../apps/api/feed-relay.mjs';
import { evaluateOperations } from '../apps/api/operations-health.mjs';
import { testnets } from '../packages/core/networks.mjs';
import { usdOracles } from '../packages/core/usd-oracles.mjs';
import { testnetDexes } from '../packages/core/uniswap.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');
const { PublicRpcSigner } = await import('../apps/web/public-rpc-signer.mjs');

const KEY = 'robinhood-testnet', SOURCE_CHAIN = 84532, ETH = 2500n * 10n ** 8n;
const relayArt = () => testDexArtifacts().relayFeed;
const deployRelayFeed = async (signer, updater, source) => { const a = relayArt(), c = await new ContractFactory(a.abi, a.bytecode, signer).deploy('ETH / USD (test)', source, SOURCE_CHAIN, updater); await c.waitForDeployment(); return c; };

test('Robinhood testnet is registered as a test chain: its labelled test DEX and its relay feed as the launch oracle', () => {
  const net = testnets.find(n => n.key === KEY);
  assert.equal(net.chainId, 46630); assert.equal(net.testDex, true); assert.ok(!net.mainnet);
  assert.equal(net.relay.source.network, 'base-sepolia');
  assert.equal(net.relay.source.feed, usdOracles({})['base-sepolia'].feed, 'relays the Chainlink feed Base Sepolia launches already use');
  assert.ok(net.relay.maxAge > 0 && net.relay.maxAge <= 86400);
  const dex = testnetDexes[KEY];
  assert.equal(dex.enabled, true); assert.equal(dex.testDeployment, true); assert.match(dex.name, /Elpida test deployment/, 'never shown as Uniswap\'s own');
  const oracle = usdOracles({})[KEY];
  assert.equal(oracle.feed, net.relay.feed); assert.equal(oracle.maxAge, net.relay.maxAge); assert.equal(oracle.available, true);
  assert.match(oracle.source, /relayed from base-sepolia/);
  // The team launchpad, pinned so the public indexer lists Robinhood testnet tokens for everyone.
  assert.equal(net.shared.model, 'curve-dex-v10'); assert.equal(net.shared.launchFeaturesVersion, 1);
  assert.ok(net.shared.block > 141826583, 'deployed after the test DEX it graduates into');
});

test('ElpidaRelayFeed: only its updater posts, rounds only move forward, never into the future', async t => {
  const f = await dexFixture(t), [owner, updater, other] = f.signers;
  const feed = await deployRelayFeed(owner, f.addresses[1], f.feed.target);
  assert.equal(await feed.decimals(), 8n); assert.equal(await feed.source(), f.feed.target); assert.equal(await feed.sourceChainId(), BigInt(SOURCE_CHAIN));
  await assert.rejects(feed.latestRoundData(), /NoRound|revert/, 'no price before the first relayed round');
  const now = BigInt(await f.now());
  await assert.rejects(feed.connect(other).post(ETH, now - 10n, 5n), /NotUpdater|revert/);
  await assert.rejects(feed.connect(updater).post(0n, now - 10n, 5n), /InvalidRound|revert/, 'positive answers only');
  await assert.rejects(feed.connect(updater).post(ETH, now + 3600n, 5n), /InvalidRound|revert/, 'no future timestamps');
  await mined(feed.connect(updater).post(ETH, now - 10n, 5n));
  const [round, answer, startedAt, updatedAt, answeredIn] = await feed.latestRoundData();
  assert.deepEqual([round, answer, startedAt, updatedAt, answeredIn].map(BigInt), [1n, ETH, now - 10n, now - 10n, 1n], 'the source timestamp, not the block time');
  await assert.rejects(feed.connect(updater).post(ETH, now - 10n, 6n), /InvalidRound|revert/, 'same timestamp: refused');
  await assert.rejects(feed.connect(updater).post(ETH, now - 5n, 5n), /InvalidRound|revert/, 'same source round: refused');
  await assert.rejects(feed.connect(other).setUpdater(f.addresses[2]), /NotOwner|revert/);
  await mined(feed.connect(owner).setUpdater(f.addresses[2]));
  await assert.rejects(feed.connect(updater).post(ETH, now - 1n, 7n), /NotUpdater|revert/, 'the old updater is out');
});

function relayFor(f, { key, chainId = 31337, feed = null, sourceFeed, wallet, maxAge = 3600, testChains = new Set([31337]) }) {
  const networks = [{ key, chainId, rpcUrl: 'local', relay: { source: { network: 'src', feed: sourceFeed }, feed, maxAge } }, { key: 'src', chainId: SOURCE_CHAIN, rpcUrl: 'local' }];
  const logs = [];
  const relay = new FeedRelay({ networks, env: { ELPIDA_TESTNET_RELAY_KEY: wallet?.privateKey ?? '' }, providerFactory: () => f.provider, log: l => logs.push(l), now: () => f.clock, testChains });
  return { relay, logs };
}

test('the server relay copies Chainlink rounds with their own timestamps, and refuses mainnet, a wrong updater or a stale source', async t => {
  const f = await dexFixture(t), relayWallet = Wallet.createRandom();
  await mined(f.signers[0].sendTransaction({ to: relayWallet.address, value: parseEther('1') }));
  f.clock = await f.now();
  // Not configured yet: idle, with a clear state; the key never appears in any status.
  let { relay } = relayFor(f, { key: KEY, sourceFeed: f.feed.target, wallet: relayWallet });
  await relay.tick();
  assert.equal(relay.status().networks[KEY].error, 'FEED_NOT_DEPLOYED');
  assert.equal(relay.publicConfig().address, relayWallet.address);
  assert.ok(!JSON.stringify([relay.status(), relay.publicConfig()]).includes(relayWallet.privateKey.slice(2)), 'the key is never exposed');
  // Deployed with this relay as updater: the first tick posts the source round.
  const feed = await deployRelayFeed(f.signers[0], relayWallet.address, f.feed.target);
  await mined(f.feed.set(ETH, f.clock - 30, 7, 7));
  ({ relay } = relayFor(f, { key: KEY, feed: feed.target, sourceFeed: f.feed.target, wallet: relayWallet }));
  await relay.tick();
  let s = relay.status().networks[KEY];
  assert.equal(s.error, null); assert.ok(s.lastPost?.hash);
  assert.deepEqual([...(await feed.latestRoundData())].slice(1, 4), [ETH, BigInt(f.clock - 30), BigInt(f.clock - 30)], 'Chainlink\'s own timestamp');
  // Nothing new at the source: no transaction.
  const posted = await feed.latestRound(); await relay.tick(); assert.equal(await feed.latestRound(), posted);
  // A new source round is relayed.
  f.clock = await f.now(); await mined(f.feed.set(ETH + 10n ** 8n, f.clock - 5, 8, 8)); await relay.tick();
  assert.equal(await feed.latestRound(), posted + 1n); assert.equal((await feed.latestRoundData())[1], ETH + 10n ** 8n);
  // A stale source is not relayed: a stopped Chainlink feed stays visibly stale.
  f.clock += 7200; await mined(f.feed.set(ETH, f.clock - 4000, 9, 9)); await relay.tick();
  assert.equal(relay.status().networks[KEY].error, 'SOURCE_STALE'); assert.equal(await feed.latestRound(), posted + 1n);
  // Operations: a relayed price older than the maximum age is critical (launches there are refused).
  const ops = evaluateOperations({ now: f.clock * 1000, startedAt: 0, durable: true, backup: { enabled: true, lastSuccess: new Date(f.clock * 1000).toISOString(), intervalMs: 3600000 }, relay: relay.status() });
  assert.deepEqual(ops.incidents.filter(i => i.code.startsWith('price_relay')).map(i => [i.code, i.severity]), [['price_relay_' + KEY, 'critical']]);
  // Another updater on the feed: refused before signing anything.
  const foreign = await deployRelayFeed(f.signers[0], f.addresses[3], f.feed.target);
  ({ relay } = relayFor(f, { key: KEY, feed: foreign.target, sourceFeed: f.feed.target, wallet: relayWallet }));
  await relay.tick(); assert.equal(relay.status().networks[KEY].error, 'NOT_THE_UPDATER');
  // A mainnet chain ID, even with everything else right: refused.
  ({ relay } = relayFor(f, { key: 'robinhood-mainnet', chainId: 4663, feed: feed.target, sourceFeed: f.feed.target, wallet: relayWallet, testChains: undefined }));
  const nonce = await f.provider.getTransactionCount(relayWallet.address);
  await relay.tick(); assert.equal(relay.status().networks['robinhood-mainnet'].error, 'NOT_A_TEST_CHAIN');
  assert.equal(await f.provider.getTransactionCount(relayWallet.address), nonce, 'nothing was sent');
  // A malformed key: reported, never used.
  const bad = new FeedRelay({ networks: [], env: { ELPIDA_TESTNET_RELAY_KEY: 'not-a-key' } });
  assert.equal(bad.status().misconfigured, true); assert.equal(bad.address, null);
});

function walletOn(f, signer, config, net) {
  const store = new Map(); globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const c = n => ({ abi: art(n).abi, bytecode: '0x' + art(n).evm.bytecode.object });
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, {
    net, provider: f.provider, onProgress: () => {}, launches: new Map(),
    _eth: { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [w.address] : null },
    config: { ...config, contracts: { adapter: c('ElpidaV3MigrationAdapter'), atomicFactory: c('ElpidaAtomicDexFactory'), dexFactory: c('ElpidaDexFactory'), legacyFactory: c('ElpidaBetaFactory'), dexCurve: { abi: art('ElpidaDexCurve').abi }, legacyCurve: { abi: art('ElpidaBetaCurve').abi }, quote: { abi: art('ElpidaToken').abi } } },
  });
  Object.defineProperty(w, 'eth', { get: () => w._eth });
  return signer.getAddress().then(address => { w.address = address; w.signer = new PublicRpcSigner(signer, f.provider, { pollMs: 5 }); return w; });
}

test('Robinhood testnet path: deploy the test DEX and relay feed from the site, relay a price, set up the launchpad, launch and graduate', async t => {
  const f = await dexFixture(t), owner = f.signers[0], relayWallet = Wallet.createRandom();
  await mined(owner.sendTransaction({ to: relayWallet.address, value: parseEther('1') }));
  const net = { chainId: 31337, key: KEY, name: 'Robinhood Chain Testnet', testDex: true, nativeCurrency: { symbol: 'ETH' } };
  const relayConfig = { address: relayWallet.address, networks: { [KEY]: { feed: null, source: { network: 'base-sepolia', chainId: SOURCE_CHAIN, feed: f.feed.target }, maxAge: 3600 } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url) === '/api/test-dex-artifacts' ? { ok: true, json: async () => JSON.parse(JSON.stringify(testDexArtifacts())) } : realFetch(url);
  t.after(() => { globalThis.fetch = realFetch; });

  // 1. No relay configured on the server: refused before any transaction.
  let w = await walletOn(f, owner, { relay: { address: null, networks: {} } }, net);
  await assert.rejects(w.deployTestDex(), /price relay is not configured/);
  // 2. The site deploys the six contracts and saves their addresses; a second run deploys nothing.
  w = await walletOn(f, owner, { relay: relayConfig }, net);
  const steps = []; w.onProgress = m => steps.push(m);
  const { testDex } = await w.deployTestDex();
  assert.equal(steps.length, 6); assert.ok(steps.every(s => /Elpida test deployment/.test(s)));
  for (const k of ['weth', 'factory', 'manager', 'router', 'quoter', 'feed']) assert.notEqual(await f.provider.getCode(testDex[k]), '0x', k);
  assert.deepEqual(w.savedTestDex(), testDex);
  const nonce = await f.provider.getTransactionCount(f.addresses[0]); await w.deployTestDex();
  assert.equal(await f.provider.getTransactionCount(f.addresses[0]), nonce, 'resumes: nothing redeployed');
  const weth = new Contract(testDex.weth, testDexArtifacts().weth.abi, f.provider);
  assert.equal(await weth.name(), 'Wrapped Ether (Elpida test deployment)');
  const feed = new Contract(testDex.feed, relayArt().abi, f.provider);
  assert.equal(await feed.updater(), relayWallet.address); assert.equal(await feed.source(), f.feed.target);
  assert.match(await feed.description(), /relayed from base-sepolia; testnet only/);

  // 3. The server relay posts the current Chainlink round.
  f.clock = await f.now(); await mined(f.feed.set(ETH, f.clock - 20, 11, 11));
  const { relay } = relayFor(f, { key: KEY, feed: testDex.feed, sourceFeed: f.feed.target, wallet: relayWallet });
  await relay.tick(); assert.equal(relay.status().networks[KEY].error, null);

  // 4. Registered (as the team does in uniswap.mjs and networks.mjs): the normal launchpad setup uses them.
  const dex = { name: 'Uniswap v3 (Elpida test deployment)', fee: 10000, factory: testDex.factory, manager: testDex.manager, router: testDex.router, quoter: testDex.quoter, weth: testDex.weth, routerVersion: 2 };
  w = await walletOn(f, owner, { relay: relayConfig, publicDexes: { [KEY]: dex }, oracles: { [KEY]: { feed: testDex.feed, maxAge: 3600, available: true } } }, net);
  await assert.rejects(w.deployTestDex(), /already has Uniswap v3 \(Elpida test deployment\)/);
  await w.deploy({});
  const factory = new Contract(w.deployment.factory, art('ElpidaAtomicDexFactory').abi, owner);
  assert.equal(await factory.usdFeed(), testDex.feed, 'priced by the relay feed');
  assert.equal(await factory.launchFee(), parseEther('0.004'), '$10 at the relayed $2,500');

  // 5. Launch, complete: the final buy graduates into the test Uniswap v3 pool, locked.
  const g = { ...f, factory, dex: { weth: { target: testDex.weth } } };
  const l = await launch(g, { name: 'Hood', symbol: 'HOOD' });
  await complete(g, l);
  const pool = await l.curve.pool();
  assert.notEqual(pool, ZeroAddress, 'graduated in the completing buy');
  const v3 = new Contract(testDex.factory, ['function getPool(address,address,uint24) view returns(address)'], f.provider);
  assert.equal(await v3.getPool(l.token.target, testDex.weth, 10000), pool, 'the pool is in the test Uniswap v3');

  // 6. If the relay stops, the relayed price ages out and launches are refused, as with a stopped Chainlink feed.
  await f.advance(3601);
  await assert.rejects(factory.launchFee(), /StaleOraclePrice|revert/);
});
