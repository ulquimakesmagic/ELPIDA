// ELPIDA V2 in the browser: the operator deploys the V2 test launchpad with its reward contracts from the page, a creator
// launches with their own fee and a capped first buy, and a trader buys and sells through the router, exactly as the
// site calls them, on a local cancun chain with Uniswap's own PoolManager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, formatUnits, parseEther } from 'ethers';
import './helpers/browser-modules.mjs';
import { v4Fixture, v4Art, mined, TEST_URI } from './helpers/v4-fixture.mjs';
import { v4Artifacts } from '../apps/api/v4-artifacts.mjs';
import { V2Indexer } from '../packages/indexer/v2-indexer.mjs';
import { V2_MODEL, splitFee } from '../packages/core/v2-economics.mjs';

const { deployV2, launchV2, v2LaunchTerms, splitPreview, feeBpsFrom, v2StockPairs, approveV2Stock, claimCreatorSplit, creatorSplitState } = await import('../apps/web/v2-launchpad.mjs');
const { v2Deployment, v4Quote, v4Trade, isV4Token, isV2Token, v4WithdrawFees } = await import('../apps/web/v4-launchpad.mjs');

function browser(t) {
  const store = new Map(), oldStorage = globalThis.localStorage, oldFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === '/api/v4-artifacts') return reply(JSON.parse(JSON.stringify(v4Artifacts())));
    if (u.startsWith('/api/metadata/challenge')) return reply({ id: 'a'.repeat(48), digest: new URL(u, 'http://x').searchParams.get('digest'), difficulty: 1, expires: Date.now() + 60000 });
    if (u === '/api/metadata/stage') return reply({ uri: TEST_URI, storage: 'elpida-hosted', metadata: {} });
    throw new Error('unexpected fetch ' + u);
  };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.fetch = oldFetch; });
  return store;
}

async function walletFor(f, signer, net) {
  const address = await signer.getAddress(), progress = [];
  return { net, provider: f.provider, signer, address, config: { csrf: 'test' }, progress, onProgress: m => progress.push(m),
    oracle: { available: true, feed: f.feed.target, maxAge: 86400, usdc: f.usdc.target },
    async oraclePrice() { return { usd: 2500, status: 'fresh' }; }, async checkNetwork() {},
    async wait(pending, message) { this.onProgress(message); const tx = await pending; return { tx, receipt: await tx.wait() }; },
    async sendCalls(calls, message) { this.onProgress(message); let last; for (const c of calls) { const tx = await signer.sendTransaction({ to: c.to, data: c.data, value: c.value ?? 0n }); last = { tx, receipt: await tx.wait() }; } return last; } };
}

test('the launch form’s fee helpers', () => {
  assert.equal(feeBpsFrom('1.25'), 125); assert.equal(feeBpsFrom('4'), 400); assert.throws(() => feeBpsFrom('1.255'), /two decimals/);
  const p = splitPreview('1000', 250, 6);
  assert.equal(p.fee, '25.0');
  assert.deepEqual(p.parts.map(x => x.amount), ['7.5', '7.5', '2.5', '2.5', '5.0']);
  assert.deepEqual(splitFee(25_000_000n), { creator: 7_500_000n, traderAirdrop: 7_500_000n, flywheel: 2_500_000n, holderRewards: 2_500_000n, treasury: 5_000_000n });
});

test('operator deploys V2 with its reward contracts from the browser; a creator launches at 2.5%; a trader buys and sells', async t => {
  const store = browser(t), f = await v4Fixture(t), owner = f.signers[2];
  const net = { key: 'base-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target, shared: null } };
  const ow = await walletFor(f, owner, net);
  const { record, message } = await deployV2(ow);
  assert.match(message, /v2\.shared/);
  assert.equal(record.model, V2_MODEL); assert.equal(record.minFeeBps, 100);
  for (const k of ['factory', 'hook', 'router', 'airdrop', 'holder', 'flywheel']) assert.match(record[k], /^0x[0-9a-fA-F]{40}$/, k);
  assert.equal(v2Deployment(net).factory, record.factory); assert.equal(v2Deployment(net).pinned, false);
  const hook = new Contract(record.hook, v4Art('ElpidaV2Hook').abi, f.provider), factory = new Contract(record.factory, v4Art('ElpidaV2Factory').abi, f.provider);
  assert.equal((await hook.flywheelVault()).toLowerCase(), record.flywheel.toLowerCase());
  assert.equal(await factory.startMcapUsd(), 50n); assert.equal(await factory.testSized(), true);
  assert.equal((await new Contract(record.flywheel, v4Art('ElpidaV2FlywheelVault').abi, f.provider).router()).toLowerCase(), record.router.toLowerCase());
  assert.equal(Number(await new Contract(record.airdrop, v4Art('ElpidaV2Distributor').abi, f.provider).period()), 0, 'airdrop rounds are calendar months');
  assert.ok(await factory.approvedQuotes(f.usdc.target) === 62_500_000n, 'USDC pair at $50 × 5/4');
  await assert.rejects(deployV2(ow), /already deployed from this browser/);
  assert.ok(![...store.keys()].some(k => k.endsWith(':progress')));
  // The creator: terms, a first buy above 3% refused before anything is sent, then a launch at 2.5%.
  const cw = await walletFor(f, f.signers[0], net);
  const terms = await v2LaunchTerms(cw, { feeBps: 250 });
  assert.equal(terms.minFeeBps, 100); assert.equal(terms.maxFeeBps, 400); assert.equal(terms.firstBuyCapTokens, '30000000.0');
  const tooMuch = (parseEther(terms.maxFirstBuy) * 102n / 100n).toString();
  await assert.rejects(launchV2(cw, { name: 'Hope', symbol: 'hope', feeBps: 250, firstBuy: formatUnits(tooMuch, 18) }), /at most 3% of the supply/);
  await assert.rejects(launchV2(cw, { name: 'Hope', symbol: 'HOPE!', feeBps: 250 }), /1 to 10 letters or digits/);
  await assert.rejects(launchV2(cw, { name: 'Hope', symbol: 'HOPE', feeBps: 401 }), /from 1\.00% to 4\.00%/);
  // A first buy paid in the native coin: only on a pair-asset launch, only where a conversion route exists, before any send.
  const sentBefore = await f.provider.getTransactionCount(cw.address);
  await assert.rejects(launchV2(cw, { name: 'Hope', symbol: 'HOPE', feeBps: 250, firstBuyPayment: 'native', nativeBuy: '0.01' }), /already uses the native coin/);
  await assert.rejects(launchV2(cw, { name: 'Hope', symbol: 'HOPE', feeBps: 250, pair: 'usdc', firstBuyPayment: 'native', nativeBuy: '0.01' }), /no ETH conversion route/);
  assert.equal(await f.provider.getTransactionCount(cw.address), sentBefore, 'nothing was sent');
  const launched = await launchV2(cw, { name: 'Hope', symbol: 'hope', feeBps: 250, firstBuy: terms.maxFirstBuy, description: 'test', image: '' });
  assert.equal(launched.feeBps, 250);
  const token = new Contract(launched.token, v4Art('ElpidaV2Token').abi, f.provider);
  assert.equal(await token.symbol(), 'hope', 'tickers are kept as typed');
  const held = await token.balanceOf(cw.address);
  assert.ok(held <= 30_000_000n * 10n ** 18n && held > 29_900_000n * 10n ** 18n, `the maximum first buy takes just under 3% (${formatUnits(held, 18)})`);
  // The site lists it from the V2 index and trades it through the router like a Model 11 token.
  const index = new V2Indexer({ provider: f.provider, factory: record.factory, hook: record.hook, poolManager: f.manager.target, router: record.router, fromBlock: record.block });
  t.after(() => index.close());
  await index.sync();
  const item = { ...index.listings()[0], deploymentModel: V2_MODEL, factory: record.factory };
  assert.equal(isV2Token(item), true); assert.equal(isV4Token(item), true);
  await f.advance(120);
  const bw = await walletFor(f, f.signers[1], net);
  const q = await v4Quote(bw, item, 'buy', '0.02');
  assert.equal(q.feeBps, 250); assert.equal(q.fee, '0.0005'); assert.equal(q.antiSnipeActive, false);
  const before = await token.balanceOf(bw.address);
  await v4Trade(bw, item, 'buy', { amount: '0.02', slippage: '1' });
  assert.equal(formatUnits(await token.balanceOf(bw.address) - before, 18), q.out, 'the quote is the trade');
  await v4Trade(bw, item, 'sell', { amount: formatUnits((await token.balanceOf(bw.address)) / 2n, 18), slippage: '1' });
  await index.sync();
  assert.deepEqual(index.trades(item.address).map(x => x.side).reverse(), ['buy', 'buy', 'sell']);
  // Fees go to the five recipients; the flywheel vault receives its share directly.
  await v4WithdrawFees(bw, item);
  assert.ok(await f.provider.getBalance(record.flywheel) > 0n);
  await assert.rejects(v4Trade(bw, { ...item, factory: '0x0000000000000000000000000000000000000001' }, 'buy', { amount: '0.01' }), /another V2 launchpad/);

  // Creator split: the creator's 30% goes to an ownerless split contract for 3 wallets (50/30/20); each wallet is paid
  // only its share, whoever presses the button; a second launch with the same split reuses the same contract.
  const { art } = await import('./helpers/dex-fixture.mjs'), { Wallet } = await import('ethers');
  const alloc = art('ElpidaCreatorAllocation');
  cw.config.contracts = { creatorAllocation: { abi: alloc.abi, bytecode: '0x' + alloc.evm.bytecode.object } };
  const third = Wallet.createRandom().address, rewardSplit = [{ wallet: cw.address, bps: 5000 }, { wallet: bw.address, bps: 3000 }, { wallet: third, bps: 2000 }];
  await assert.rejects(launchV2(cw, { name: 'Split', symbol: 'SPLIT', feeBps: 300, rewardSplit: [{ wallet: cw.address, bps: 5000 }, { wallet: third, bps: 4000 }] }), /exactly 100%/);
  await assert.rejects(launchV2(cw, { name: 'Split', symbol: 'SPLIT', feeBps: 300, rewardSplit: [{ wallet: cw.address, bps: 5000 }, { wallet: cw.address, bps: 5000 }] }), /appear once/);
  const splitLaunch = await launchV2(cw, { name: 'Split', symbol: 'SPLIT', feeBps: 300, rewardSplit, description: '', image: '' });
  assert.ok(cw.progress.some(m => /Deploy your creator split \(3 wallets\)/.test(m)));
  await index.sync();
  const splitItem = { ...index.listings().find(x => x.address.toLowerCase() === splitLaunch.token.toLowerCase()), deploymentModel: V2_MODEL, factory: record.factory };
  await f.advance(120);
  await v4Trade(bw, splitItem, 'buy', { amount: '0.05', slippage: '1' });
  const before3 = await f.provider.getBalance(third);
  await claimCreatorSplit(bw, { token: splitItem.address, wallet: third });
  const paid3 = await f.provider.getBalance(third) - before3;
  assert.ok(paid3 > 0n, 'the third wallet was paid by someone else pressing the button');
  const state = await creatorSplitState({ provider: f.provider, net, token: splitItem.address });
  assert.deepEqual(state.rows.map(r => r.bps), [5000, 3000, 2000]);
  assert.equal(state.rows[2].claimable, 0n, 'paid out');
  const [a, b] = state.rows.map(r => r.claimable);
  assert.ok(a > 0n && a * 3000n / 5000n - b <= 1n && paid3 * 5000n / 2000n - a <= 2n, `shares follow 50/30/20 (${a}, ${b}, ${paid3})`);
  await assert.rejects(claimCreatorSplit(bw, { token: splitItem.address, wallet: Wallet.createRandom().address }), /not in this token's creator split/);
  cw.progress.length = 0;
  await launchV2(cw, { name: 'Split two', symbol: 'SPLIT2', feeBps: 300, rewardSplit, description: '', image: '' });
  assert.ok(cw.progress.some(m => /Reusing your creator split/.test(m)), 'the same split is reused');
});

test('V2 deploy: a lagging wallet’s reused nonce is asked again; a resumed deploy replaces reward contracts run by the wrong operator; test stocks become V2 pairs', async t => {
  browser(t); const f = await v4Fixture(t), owner = f.signers[2], keeper = await f.signers[3].getAddress();
  const net = { key: 'base-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target, shared: null } };
  const ow = await walletFor(f, owner, net), send = owner.sendTransaction.bind(owner);
  let sends = 0, refusedNonce = false;
  owner.sendTransaction = async tx => {
    sends++;
    if (sends === 2 && !refusedNonce) { refusedNonce = true; throw new Error('could not coalesce error (error={ "code": -32000, "message": "nonce too low: next nonce 135, tx nonce 134" })'); }
    if (sends === 5) throw Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' });
    return send(tx);
  };
  // First attempt: no keeper configured (the wallet would run the reward contracts); the operator rejects step 4.
  await assert.rejects(deployV2(ow), /rejected/);
  assert.ok(refusedNonce && ow.progress.some(m => /reused a transaction number/.test(m)), 'the reused nonce was asked again');
  // Second attempt, with the server keeper: the airdrop distributor run by the wallet is replaced.
  const { record } = await deployV2(ow, { keeper });
  owner.sendTransaction = send;
  for (const k of ['airdrop', 'holder', 'flywheel']) assert.equal((await new Contract(record[k], ['function operator() view returns(address)'], f.provider).operator()).toLowerCase(), keeper.toLowerCase(), `${k} is run by the keeper`);
  assert.equal(record.keeper.toLowerCase(), keeper.toLowerCase());
  const hook = new Contract(record.hook, v4Art('ElpidaV2Hook').abi, f.provider);
  assert.equal((await hook.traderAirdropVault()).toLowerCase(), record.airdrop.toLowerCase(), 'the hook pays the new airdrop distributor');
  // A test stock (approved on Model 10 at start × 10/9) becomes a V2 pair at start × 5/4, and a creator launches on it.
  const stock = await new ContractFactory(v4Art('MockIssuerStock').abi, v4Art('MockIssuerStock').evm.bytecode.object, owner).deploy();
  await stock.waitForDeployment();
  const m10 = 55_555_555_555_555_555_555n; // Model 10's virtual quote for this test stock
  const listed = [{ kind: 'xstock', test: true, address: stock.target, symbol: 'mSTK', virtualQuote: m10.toString() }];
  ow.approvedQuotes = listed;
  assert.deepEqual((await v2StockPairs(ow)).map(s => s.approved), [false]);
  await approveV2Stock(ow, { asset: stock.target });
  const factory = new Contract(record.factory, v4Art('ElpidaV2Factory').abi, f.provider);
  assert.equal(await factory.approvedQuotes(stock.target), m10 * 9n / 8n);
  assert.match((await approveV2Stock(ow, { asset: stock.target })).message, /already a V2 pair/);
  const cw = await walletFor(f, f.signers[0], net); cw.approvedQuotes = listed;
  await mined(stock.mint(cw.address, parseEther('10')));
  const launched = await launchV2(cw, { name: 'Stocky', symbol: 'STK', feeBps: 200, pair: 'xstock', quoteAsset: stock.target, firstBuy: '1', description: '', image: '' });
  const token = new Contract(launched.token, v4Art('ElpidaV2Token').abi, f.provider);
  assert.ok(await token.balanceOf(cw.address) > 0n);
  assert.equal((await hook.launchOf(launched.token)).quote.toLowerCase(), stock.target.toLowerCase());
});

test('a test stock listed twice (overlapping pair loads) shows once in the V2 and Model 11 lists', async t => {
  browser(t);
  const stock = { kind: 'xstock', test: true, address: '0x00000000000000000000000000000000000000aa', symbol: 'tAAPLon', virtualQuote: '1' };
  const net = { key: 'base-sepolia', chainId: 999001, v4: { poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408' }, v2: { shared: { factory: '0x0000000000000000000000000000000000000f01', hook: '0x0000000000000000000000000000000000000f02', router: '0x0000000000000000000000000000000000000f03', block: 1 } } };
  const provider = { call: async () => '0x' + '0'.repeat(64) };
  const w = { net, provider, approvedQuotes: [stock, { ...stock, address: stock.address.toUpperCase().replace('0X', '0x') }] };
  assert.equal((await v2StockPairs(w)).length, 1);
});
