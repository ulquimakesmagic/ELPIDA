// USDC payouts (contracts/evm/v2/ElpidaV2UsdcDistributor.sol; Malik, 10 November): the trader airdrop and holder
// rewards convert every asset to USDC and pay only USDC. The hook and its distributors are unchanged: each finished
// round's balance moves into a USDC distributor, is converted on Uniswap v3 there, and is paid in USDC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, parseEther, ZeroAddress, solidityPacked } from 'ethers';
import './helpers/browser-modules.mjs';
import { v2Fixture, launchV2, trade, mined, revertsWith, errorSelector } from './helpers/v2-fixture.mjs';
import { verifyPayout } from '../packages/core/v2-rounds.mjs';
import { V2Indexer } from '../packages/indexer/v2-indexer.mjs';
import { V2RewardsIndexer } from '../packages/indexer/v2-rewards.mjs';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';
import { v4Artifacts } from '../apps/api/v4-artifacts.mjs';

const { deployV2UsdcDistributors, v2UsdcDistributors } = await import('../apps/web/v2-launchpad.mjs');

const DAY = 86_400, ZERO_ROOT = '0x' + '0'.repeat(64);

test('the USDC distributor: only the operator converts, only into USDC, and it posts USDC rounds only', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true, usdcPayouts: true }), d = f.contracts.usdcAirdrop, keeper = f.signers[4], v3 = f.contracts.v3;
  assert.equal(await d.VERSION(), 2n);
  assert.equal((await d.source()).toLowerCase(), f.contracts.airdrop.target.toLowerCase());
  await mined(f.signers[0].sendTransaction({ to: d.target, value: parseEther('0.1') }));
  const good = solidityPacked(['address', 'uint24', 'address'], [v3.weth.target, 3000, f.usdc.target]);
  await revertsWith(d.connect(f.signers[1]).convert(ZeroAddress, parseEther('0.1'), 1n, good), errorSelector(d, 'OnlyOperator'));
  // The path must start at the asset (the wrapped coin for native) and end at USDC.
  const wrongEnd = solidityPacked(['address', 'uint24', 'address'], [v3.weth.target, 3000, f.stock.target]);
  await revertsWith(d.connect(keeper).convert(ZeroAddress, parseEther('0.1'), 1n, wrongEnd), errorSelector(d, 'BadTerms'));
  await revertsWith(d.connect(keeper).convert(ZeroAddress, parseEther('0.2'), 1n, good), errorSelector(d, 'NotFunded'));
  // A minimum above what the pool gives reverts; a fair one converts and keeps the USDC here.
  await revertsWith(d.connect(keeper).convert(ZeroAddress, parseEther('0.1'), 10n ** 12n, good), 'Too little received');
  await mined(d.connect(keeper).convert(ZeroAddress, parseEther('0.1'), 240n * 10n ** 6n, good));
  const usdcHeld = await f.usdc.balanceOf(d.target);
  assert.ok(usdcHeld >= 240n * 10n ** 6n && usdcHeld < 251n * 10n ** 6n, `about $250 of USDC (${usdcHeld})`);
  assert.equal(await f.provider.getBalance(d.target), 0n);
  // Rounds are USDC only.
  const r = Number(await d.currentRound()), end = Number(await d.roundEnd(r));
  await f.provider.send('evm_setNextBlockTimestamp', [end]); await f.provider.send('evm_mine', []);
  await revertsWith(d.connect(keeper).postRoot(r, ZeroAddress, '0x' + '1'.repeat(64), 1n, 1, ''), errorSelector(d, 'BadTerms'));
  await mined(d.connect(keeper).postRoot(r, f.usdc.target, '0x' + '1'.repeat(64), usdcHeld, 1, ''));
});

test('with USDC distributors pinned, the keeper converts every vault asset and pays the airdrop and holder rewards in USDC only', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true, usdcPayouts: true }), { airdrop, holder, flywheel, usdcAirdrop, usdcHolder, v3 } = f.contracts;
  const index = new V2Indexer({ provider: f.provider, factory: f.factory.target, hook: f.hook.target, poolManager: f.manager.target, router: f.router.target });
  t.after(() => index.close());
  let chainTime = (await f.provider.getBlock('latest')).timestamp;
  const tick = async () => { chainTime = (await f.provider.getBlock('latest')).timestamp; await index.sync(); };
  const deployment = { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target, usdcAirdrop: usdcAirdrop.target, usdcHolder: usdcHolder.target,
    poolManager: f.manager.target, router: f.router.target, factory: f.factory.target };
  const keeper = new V2Keeper({ workers: [{ chain: 'local', net: { chainId: 31337, key: 'local' }, provider: f.provider, signer: f.signers[4], deployment,
    dex: v3.config, usdc: f.usdc.target,
    index: () => index, usdPerUnit: a => (a === ZeroAddress.toLowerCase() ? 2500 : a === f.usdc.target.toLowerCase() ? 1 : null) }], now: () => chainTime, publicUrl: 'https://elpida.test' });
  // Three tokens: native-paired, USDC-paired and paired with an unpriced test stock that has no USDC route.
  const native = await launchV2(f, { feeBps: 300, symbol: 'NAT', firstBuy: parseEther('0.2') }), usdc = await launchV2(f, { feeBps: 300, pair: 'usdc', symbol: 'USD' });
  await mined(f.factory.connect(f.owner).approveQuote(f.stock.target, parseEther('100')));
  const stock = await launchV2(f, { feeBps: 300, pair: 'stock', symbol: 'STK' });
  await mined(native.token.connect(f.signers[0]).transfer(f.addresses[3], (await native.token.balanceOf(f.addresses[0])) / 2n));
  await f.advance(61);
  for (let day = 0; day < 3; day++) {
    for (const i of [1, 2]) {
      await trade(f, native, { signer: f.signers[i], buy: true, amount: parseEther('0.3') });
      await trade(f, usdc, { signer: f.signers[i], buy: true, amount: 600n * 10n ** 6n });
      await trade(f, stock, { signer: f.signers[i], buy: true, amount: parseEther('5') });
    }
    await f.advance(DAY);
  }
  await tick();
  const w = keeper.workers[0], jump = async to => { await f.provider.send('evm_setNextBlockTimestamp', [to]); await f.provider.send('evm_mine', []); };
  await keeper.fees(w);
  const stockInHolder = await f.stock.balanceOf(holder.target);
  assert.ok(stockInHolder > 0n && await f.provider.getBalance(holder.target) > 0n && await f.usdc.balanceOf(holder.target) > 0n);

  // Weekly holder rewards: the native and USDC shares move over, the native one is converted, holders are paid USDC.
  const hr = Number(await holder.currentRound()), nativeInHolder = await f.provider.getBalance(holder.target);
  await jump(Number(await holder.roundEnd(hr))); await tick();
  await keeper.holder(w);
  assert.equal((await holder.rounds(hr, ZeroAddress)).recipients, 1n, 'the native share moved to the USDC distributor as a one-recipient round');
  assert.ok(await f.provider.getBalance(holder.target) < nativeInHolder);
  assert.equal(await f.provider.getBalance(usdcHolder.target), 0n, 'all of it converted');
  assert.equal(await f.stock.balanceOf(holder.target), stockInHolder, 'the stock share has no USDC route, so it stays');
  assert.equal(await f.stock.balanceOf(usdcHolder.target), 0n);
  assert.equal(keeper.manifest(31337, holder.target, hr, f.usdc.target).entries[0].account.toLowerCase(), usdcHolder.target.toLowerCase());
  const hm = keeper.manifest(31337, usdcHolder.target, hr, f.usdc.target);
  assert.ok(hm, 'one USDC holder round');
  assert.equal(keeper.manifest(31337, usdcHolder.target, hr, ZeroAddress), null);
  const holders = hm.entries.map(e => e.account.toLowerCase());
  for (const a of [f.addresses[1], f.addresses[2]]) assert.ok(holders.includes(a.toLowerCase()), 'holders are paid');
  for (const a of [f.addresses[0], f.addresses[3], f.manager.target, usdcHolder.target]) assert.ok(!holders.includes(a.toLowerCase()), `${a} is not paid`);
  for (const e of hm.entries) assert.ok(verifyPayout(hm, e));
  assert.equal((await usdcHolder.rounds(hr, f.usdc.target)).claimed, BigInt(hm.total), 'every holder payout was pushed in USDC');

  // Monthly airdrop: native and USDC both end up as one USDC round; the stock stays for a later round.
  const ar = Number(await airdrop.currentRound()), stockInDrop = await f.stock.balanceOf(airdrop.target);
  await jump(Number(await airdrop.roundEnd(ar))); await tick();
  await keeper.airdrop(w);
  for (const asset of [ZeroAddress, f.usdc.target]) assert.equal((await airdrop.rounds(ar, asset)).recipients, 1n, `${asset} moved to the USDC distributor`);
  assert.equal((await airdrop.rounds(ar, f.stock.target)).root, ZERO_ROOT);
  assert.equal(await f.stock.balanceOf(airdrop.target), stockInDrop);
  const m = keeper.manifest(31337, usdcAirdrop.target, ar, f.usdc.target);
  assert.ok(m, 'the USDC airdrop list');
  assert.deepEqual(m.entries.map(e => e.account.toLowerCase()).sort(), [f.addresses[1], f.addresses[2]].map(a => a.toLowerCase()).sort());
  assert.equal((await usdcAirdrop.rounds(ar, f.usdc.target)).claimed, BigInt(m.total), 'all pushed');
  assert.ok(BigInt(m.total) > 0n);
  const st = keeper.status().chains[0];
  assert.equal(st.airdropNext, ar + 1); assert.equal(st.holderNext, hr + 1);
  assert.ok(st.runs.every(r => r.status === 'ok'), JSON.stringify(st.runs));
  assert.match(st.jobs.find(j => j.job === 'airdrop').note ?? '', /no USDC route/, 'the operator panel says why the stock stayed');

  // Analytics: payouts show in USDC only; the moves into the USDC distributors are not payouts.
  const rewards = new V2RewardsIndexer({ provider: f.provider, contracts: { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target, usdcAirdrop: usdcAirdrop.target, usdcHolder: usdcHolder.target } });
  await rewards.sync();
  const s = rewards.summary(Number((await f.provider.getBlock('latest')).timestamp));
  for (const kind of ['airdrop', 'holder']) {
    assert.deepEqual([...new Set(s[kind].rounds.map(r => r.asset))], [f.usdc.target.toLowerCase()], `${kind} rounds are USDC only`);
    const native = s[kind].assets.find(a => a.asset === ZeroAddress.toLowerCase());
    assert.ok(!native || native.size <= 1n, `${kind}: the converted native share left the vault (${native?.size})`);
  }
  assert.ok(rewards.claims.every(c => c.asset === f.usdc.target.toLowerCase()), 'every payout was USDC');
  assert.ok(!rewards.claims.some(c => [usdcAirdrop.target, usdcHolder.target].map(a => a.toLowerCase()).includes(c.account)));
  assert.ok(s.airdrop.assets.find(a => a.asset === f.stock.target.toLowerCase()).size > 0n, 'the stock still shows in the airdrop vault');
});

test('the operator deploys the two USDC distributors from the admin page; they copy each distributor\'s schedule', async t => {
  const store = new Map(), oldStorage = globalThis.localStorage, oldFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.fetch = async url => { if (String(url) === '/api/v4-artifacts') return { ok: true, json: async () => JSON.parse(JSON.stringify(v4Artifacts())) }; throw new Error('unexpected fetch ' + url); };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.fetch = oldFetch; });
  const f = await v2Fixture(t, { vaults: true, convert: true }), { airdrop, holder, v3 } = f.contracts, signer = f.signers[2];
  const shared = { factory: f.factory.target, hook: f.hook.target, router: f.router.target, airdrop: airdrop.target, holder: holder.target, flywheel: f.contracts.flywheel.target, block: 0 };
  const net = { key: 'base-sepolia', name: 'Local v4', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target }, v2: { shared } };
  const wallet = (over = {}) => ({ net, provider: f.provider, signer, address: f.addresses[2], config: { v2Keeper: { address: f.addresses[4], active: true } }, onProgress() {},
    oracle: { usdc: f.usdc.target }, dex: v3.config, async wait(pending) { const tx = await pending; return { tx, receipt: await tx.wait() }; }, ...over });
  assert.equal(v2UsdcDistributors(net), null);
  await assert.rejects(deployV2UsdcDistributors(wallet({ config: {} })), /keeper, which is not running/);
  await assert.rejects(deployV2UsdcDistributors(wallet({ dex: { ...v3.config, routerVersion: 1 } })), /no Uniswap v3 router \(SwapRouter02\)/);
  await assert.rejects(deployV2UsdcDistributors(wallet({ net: { ...net, mainnet: true } })), /not approved for mainnet/);
  const { record, message } = await deployV2UsdcDistributors(wallet());
  assert.match(message, /usdcAirdrop and usdcHolder/);
  const saved = v2UsdcDistributors(net);
  assert.equal(saved.pinned, false); assert.equal(saved.airdrop, record.airdrop);
  const abi = v4Artifacts().v2.usdcDistributor.abi;
  for (const [addr, src, purpose] of [[record.airdrop, airdrop, 'trader-airdrop-usdc'], [record.holder, holder, 'holder-rewards-usdc']]) {
    const c = new Contract(addr, abi, f.provider);
    assert.equal((await c.operator()).toLowerCase(), f.addresses[4].toLowerCase());
    assert.equal((await c.source()).toLowerCase(), src.target.toLowerCase());
    assert.equal((await c.usdc()).toLowerCase(), f.usdc.target.toLowerCase());
    assert.equal(await c.period(), await src.period()); assert.equal(await c.genesis(), await src.genesis());
    assert.equal(await c.purpose(), purpose);
  }
  await assert.rejects(deployV2UsdcDistributors(wallet()), /already exist/);
  const pinned = { ...net, v2: { shared: { ...shared, usdcAirdrop: record.airdrop, usdcHolder: record.holder } } };
  assert.deepEqual(v2UsdcDistributors(pinned), { airdrop: record.airdrop, holder: record.holder, pinned: true });
});
