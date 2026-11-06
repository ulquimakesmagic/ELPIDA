// Model 11 phase 4 in the browser: the owner's deploy flow (CREATE2 deployer, factory, hook at a salt mined in the page,
// pricing, USDC pair, router), then a launch, quotes and trades through the router, driven exactly as the site calls
// them, on a local cancun chain with Uniswap's own PoolManager. fetch and localStorage are stubbed as the page has them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, keccak256, toUtf8Bytes, formatUnits, parseUnits } from 'ethers';
import './helpers/browser-modules.mjs';
import { v4Fixture, v4Art, mined, mineHookSalt as fixtureMine, HOOK_FLAGS, TEST_URI } from './helpers/v4-fixture.mjs';
import { v4Artifacts } from '../apps/api/v4-artifacts.mjs';
import { V4Indexer } from '../packages/indexer/v4-indexer.mjs';
import { V4_MODEL } from '../packages/core/v4-model.mjs';

const { mineHookSalt, deployV4, launchV4, v4Quote, v4Trade, v4Deployment, v4Available, isV4Token, v4LaunchQuote, v4WithdrawFees } = await import('../apps/web/v4-launchpad.mjs');

function browser(t) {
  const store = new Map(), oldStorage = globalThis.localStorage, oldFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === '/api/v4-artifacts') return reply(JSON.parse(JSON.stringify(v4Artifacts())));
    if (u.startsWith('/api/metadata/challenge')) return reply({ id: 'a'.repeat(48), digest: new URL(u, 'http://x').searchParams.get('digest'), difficulty: 1, expires: Date.now() + 60000 });
    if (u === '/api/metadata/stage') { browser.staged = JSON.parse(init.body); return reply({ uri: TEST_URI, storage: 'elpida-hosted', metadata: {} }); }
    throw new Error('unexpected fetch ' + u);
  };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.fetch = oldFetch; });
  return store;
}

/** The parts of TestnetWallet the Model 11 module uses, over a local signer. */
async function walletFor(f, signer, net) {
  const address = await signer.getAddress(), progress = [];
  return { net, provider: f.provider, signer, address, config: { csrf: 'test' }, progress, onProgress: m => progress.push(m),
    oracle: { available: true, feed: f.feed.target, maxAge: 86400, usdc: f.usdc.target },
    async oraclePrice() { return { usd: 2500, status: 'fresh' }; }, async checkNetwork() {},
    async wait(pending, message) { this.onProgress(message); const tx = await pending; return { tx, receipt: await tx.wait() }; },
    async sendCalls(calls, message) { this.onProgress(message); let last; for (const c of calls) { const tx = await signer.sendTransaction({ to: c.to, data: c.data, value: c.value ?? 0n }); last = { tx, receipt: await tx.wait() }; } return last; } };
}

test('the page mines the same hook salt as the test fixture and only on networks with Uniswap v4', async () => {
  const deployer = '0x5FbDB2315678afecb367f032d93F642f64180aa3', initCode = keccak256(toUtf8Bytes('elpida')) + 'ab'.repeat(40);
  const page = await mineHookSalt(deployer, initCode), fixture = fixtureMine(deployer, initCode);
  assert.equal(page.salt, fixture.salt); assert.equal(page.address, fixture.address);
  assert.equal(BigInt(page.address) & ((1n << 14n) - 1n), HOOK_FLAGS);
  const v4 = { poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408', shared: null };
  assert.equal(v4Available({ key: 'base-sepolia', v4 }), true);
  assert.equal(v4Available({ key: 'base-sepolia', v4, mainnet: true }), false, 'never on mainnet');
  assert.equal(v4Available({ key: 'robinhood-testnet', v4 }), false, 'no Model 11 on Robinhood testnet');
  assert.equal(v4Available({ key: 'bnb-testnet', v4: { poolManager: null, testPoolManager: true, shared: null } }), true, 'BNB testnet, on a test PoolManager');
  assert.equal(v4Deployment({ key: 'base-sepolia', chainId: 1, v4: { ...v4, shared: { factory: '0x1', hook: '0x2', router: '0x3', block: 9 } } }).pinned, true);
  assert.equal(isV4Token({ deploymentModel: V4_MODEL }), true); assert.equal(isV4Token({ deploymentModel: 'curve-dex-v10' }), false);
  const { testnets } = await import('../packages/core/networks.mjs');
  for (const key of ['base-sepolia', 'ethereum-sepolia']) assert.match(testnets.find(n => n.key === key).v4.poolManager, /^0x[0-9a-fA-F]{40}$/);
});

test('owner deploys the Model 11 test launchpad from the browser, then a creator launches, buys and sells through it', async t => {
  const store = browser(t), f = await v4Fixture(t), owner = f.signers[2];
  // A fresh factory in the fixture is unused here: the browser deploys its own launchpad against the same PoolManager.
  const net = { key: 'base-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target, shared: null } };
  const w = await walletFor(f, owner, net);
  const { record, message } = await deployV4(w);
  assert.match(message, /pinned in networks\.mjs/);
  assert.equal(BigInt(record.hook) & ((1n << 14n) - 1n), HOOK_FLAGS);
  const factory = new Contract(record.factory, v4Art('ElpidaV4Factory').abi, f.provider);
  assert.equal((await factory.hook()).toLowerCase(), record.hook.toLowerCase());
  assert.equal(await factory.startFdvUsd(), 50n); assert.equal(await factory.requiresMetadata(), true);
  assert.ok(await factory.approvedQuotes(f.usdc.target) > 0n, 'USDC pair approved');
  assert.deepEqual(v4Deployment(net).factory, record.factory); assert.equal(v4Deployment(net).pinned, false);
  await assert.rejects(deployV4(w), /already deployed from this browser/, 'a second deploy refuses instead of starting over');
  assert.ok(![...store.keys()].some(k => k.endsWith(':progress')), 'progress cleared once done');

  // A creator launches with a first buy; the launch-form estimate is the minimum out before slippage.
  const creator = f.signers[0], cw = await walletFor(f, creator, net);
  const estimate = await v4LaunchQuote(cw, { firstBuy: '0.01' });
  const launched = await launchV4(cw, { name: 'Hope', symbol: 'hope', firstBuy: '0.01', description: 'test', image: '' });
  assert.equal(browser.staged.symbol, 'HOPE');
  const token = new Contract(launched.token, v4Art('ElpidaToken').abi, f.provider);
  const held = await token.balanceOf(cw.address), est = parseUnits(estimate.tokens, 18);
  assert.ok((held > est ? held - est : est - held) <= est / 10n ** 12n, 'the estimate is the launch to rounding (one wei of quote per tick-bitmap word)');
  // The site lists it from the index; the module trades it through the router.
  const index = new V4Indexer({ provider: f.provider, factory: record.factory, hook: record.hook, poolManager: f.manager.target, router: record.router, fromBlock: record.block });
  await index.sync();
  const item = { ...index.listings()[0], deploymentModel: V4_MODEL, factory: record.factory };
  assert.equal(item.metadataURI, TEST_URI);
  const buyer = f.signers[1], bw = await walletFor(f, buyer, net);
  await f.advance(120);
  const q = await v4Quote(bw, item, 'buy', '0.05');
  assert.equal(q.feeBps, 125); assert.equal(q.fee, '0.000625'); assert.equal(q.venue, 'Uniswap v4');
  const before = await token.balanceOf(bw.address);
  await v4Trade(bw, item, 'buy', { amount: '0.05', slippage: '1' });
  const got = await token.balanceOf(bw.address) - before;
  assert.equal(formatUnits(got, 18), q.out, 'the quote is the trade');
  const sq = await v4Quote(bw, item, 'sell', formatUnits(got / 2n, 18));
  const eth = await f.provider.getBalance(bw.address);
  await v4Trade(bw, item, 'sell', { amount: formatUnits(got / 2n, 18), slippage: '1' });
  assert.ok(await f.provider.getBalance(bw.address) > eth, 'the seller got ETH back (net of gas)');
  await index.sync();
  assert.deepEqual(index.trades(launched.token).map(x => x.side).reverse(), ['buy', 'buy', 'sell']);
  assert.equal(index.trades(launched.token)[0].account, bw.address);
  assert.equal(index.trades(launched.token)[0].quoteAmount, sq.out);
  // Fees go to their fixed recipients; anyone may trigger it.
  const fees = await v4WithdrawFees(bw, item);
  assert.ok(fees.receipt.status === 1);
  await assert.rejects(v4Trade(bw, { ...item, factory: '0x0000000000000000000000000000000000000001' }, 'buy', { amount: '0.01' }), /another Model 11 launchpad/);
  await index.close();
});

test('a USDC-paired Model 11 launch pays its first buy in USDC after one exact approval', async t => {
  browser(t); const f = await v4Fixture(t);
  const net = { key: 'ethereum-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target, shared: null } };
  await deployV4(await walletFor(f, f.signers[2], net));
  const cw = await walletFor(f, f.signers[0], net);
  const launched = await launchV4(cw, { name: 'Dollar', symbol: 'DLR', pair: 'usdc', firstBuy: '5', description: '', image: '' });
  assert.ok(cw.progress.some(m => /Approve exactly the first buy in USDC/.test(m)));
  const token = new Contract(launched.token, v4Art('ElpidaToken').abi, f.provider);
  assert.ok(await token.balanceOf(cw.address) > 0n);
  await assert.rejects(launchV4(cw, { name: 'X', symbol: 'X', pair: 'xstock' }), /native coin or USDC/);
});

test('the deploy waits out an RPC node that lags behind, and a retry reuses a hook an earlier attempt deployed', async t => {
  const store = browser(t), f = await v4Fixture(t), owner = f.signers[2];
  const net = { key: 'ethereum-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target, shared: null } };
  // A load-balanced public RPC: the first time a new contract shows code, this node still answers "no code".
  const real = f.provider.getCode.bind(f.provider), lagged = new Set();
  f.provider.getCode = async (address, tag) => { const code = await real(address, tag), a = String(address).toLowerCase(); if (code !== '0x' && !lagged.has(a)) { lagged.add(a); return '0x'; } return code; };
  t.after(() => { f.provider.getCode = real; });
  const w = await walletFor(f, owner, net);
  const { record } = await deployV4(w);
  assert.ok(w.progress.some(m => /confirm the hook deployment/.test(m)));
  // 6 November 2026 on Ethereum Sepolia: the hook was mined, then the check after it failed. A retry then found the
  // same address and tried to deploy it again. Now a retry reuses it and carries on to the remaining steps.
  const key = `elpida:v4:deployment:${net.chainId}`;
  store.delete(key);
  store.set(key + ':progress', JSON.stringify({ create2: record.create2, factory: record.factory, block: record.block }));
  const retry = await walletFor(f, owner, net), again = await deployV4(retry);
  assert.equal(again.record.hook, record.hook, 'the same hook, not a colliding redeploy');
  assert.equal(again.record.factory, record.factory);
  assert.ok(!retry.progress.some(m => /confirm the hook deployment|connecting the hook|USD pricing|USDC pair/.test(m)), 'only the missing router is sent again');
});

test('between signatures the deploy waits until the wallet\'s own RPC has counted the last transaction', async t => {
  const { walletCaughtUp } = await import('../apps/web/v4-launchpad.mjs');
  const { walletErrorText } = await import('../apps/web/wallet.mjs');
  let calls = 0;
  const w = { address: '0x1', signer: { provider: { getTransactionCount: async () => (++calls < 3 ? 7 : 8) } } };
  await walletCaughtUp(w, 7, { delay: 1 });
  assert.equal(calls, 3, 'asked until the count passed the confirmed nonce');
  calls = 0; await walletCaughtUp({ ...w, signer: { provider: { getTransactionCount: async () => { calls++; return 7; } } } }, 7, { tries: 4, delay: 1 });
  assert.equal(calls, 4, 'gives up after its tries instead of hanging');
  assert.match(walletErrorText({ message: 'could not coalesce error (error={ "code": -32000, "message": "replacement transaction underpriced" })' }, 'Trust Wallet'), /a block behind\. Nothing was sent/);
});

test('BNB Chain testnet: the operator deploys a test copy of Uniswap\'s PoolManager, then Model 11 on it, and it trades', async t => {
  const store = browser(t), f = await v4Fixture(t), owner = f.signers[2];
  const { deployTestPoolManager, v4PoolManager, savedTestPoolManager } = await import('../apps/web/v4-launchpad.mjs');
  const { testnets } = await import('../packages/core/networks.mjs');
  const bnb = testnets.find(n => n.key === 'bnb-testnet');
  assert.equal(bnb.v4.testPoolManager, true); assert.match(bnb.v4.poolManager, /^0x[0-9a-fA-F]{40}$/, 'the test PoolManager Malik deployed is pinned');
  const net = { key: 'bnb-testnet', name: 'Local BNB', chainId: 31337, nativeCurrency: { symbol: 'tBNB' }, v4: { poolManager: null, testPoolManager: true, shared: null } };
  const w = await walletFor(f, owner, net);
  await assert.rejects(deployV4(w), /Deploy the test PoolManager first/);
  const pm = await deployTestPoolManager(w);
  assert.equal(v4PoolManager(net), pm.record.address); assert.equal(savedTestPoolManager(net).address, pm.record.address);
  const manager = new Contract(pm.record.address, ['function owner() view returns(address)', 'function protocolFeeController() view returns(address)'], f.provider);
  assert.equal(await manager.owner(), w.address);
  await assert.rejects(deployTestPoolManager(w), /already deployed from this browser/);
  const { record } = await deployV4(w);
  assert.equal(record.poolManager, pm.record.address, 'the launchpad sits on the test PoolManager');
  const cw = await walletFor(f, f.signers[0], net), launched = await launchV4(cw, { name: 'Bee', symbol: 'BEE', firstBuy: '0.01', description: '', image: '' });
  const index = new V4Indexer({ provider: f.provider, factory: record.factory, hook: record.hook, poolManager: pm.record.address, router: record.router, fromBlock: record.block, nativeSymbol: 'tBNB' });
  await index.sync();
  const item = { ...index.listings()[0], deploymentModel: V4_MODEL, factory: record.factory };
  assert.equal(item.address, launched.token.toLowerCase()); assert.equal(item.quoteSymbol, 'tBNB');
  const bw = await walletFor(f, f.signers[1], net);
  await v4Trade(bw, item, 'buy', { amount: '0.02', slippage: '1' });
  await index.sync();
  assert.equal(index.trades(launched.token).length, 2);
  await index.close();
});
