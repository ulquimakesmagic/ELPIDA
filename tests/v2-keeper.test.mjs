// ELPIDA V2.0 keepers: the plans (who gets paid, what the flywheel buys) and the keeper running them against the real
// contracts on a local chain: daily fee payouts, the flywheel, holder rewards (USDC converted to the native coin) and
// the monthly trader airdrop, each list published and posted on chain and every payout pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress, Contract } from 'ethers';
import { v2Fixture, launchV2, trade, mined, parse, v4Art } from './helpers/v2-fixture.mjs';
import { timeWeightedBalances, airdropRound, holderRound, flywheelOrders, personalFunder, boundedFunderLinks } from '../packages/core/v2-keeper-plan.mjs';
import { verifyPayout } from '../packages/core/v2-rounds.mjs';
import { V2Indexer } from '../packages/indexer/v2-indexer.mjs';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';

const DAY = 86_400, A = n => '0x' + String(n).padStart(40, '0'), E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

test('time-weighted balances count only what was held, and for how long', () => {
  const t = [{ from: A(0), to: A(1), amount: 100n, timestamp: 0 }, { from: A(0), to: A(2), amount: 100n, timestamp: 50 }, { from: A(1), to: A(3), amount: 100n, timestamp: 90 }, { from: A(3), to: A(4), amount: 100n, timestamp: 95 }];
  const w = timeWeightedBalances(t, 0, 100);
  assert.equal(w.get(A(1)), 100n * 90n); assert.equal(w.get(A(2)), 100n * 50n); assert.equal(w.get(A(3)), 100n * 5n); assert.equal(w.get(A(4)), 100n * 5n);
  const strict = timeWeightedBalances(t, 0, 100, { minHoldSeconds: 10 });
  assert.equal(strict.has(A(3)), false, 'a five-second holding does not count'); assert.equal(strict.has(A(1)), true);
  const r = holderRound({ transfers: t, start: 0, end: 100, pool: 1_000_000n, excluded: [A(2)], rules: { ...holderRoundRules(), minHoldSeconds: 0 } });
  assert.equal(r.payouts.has(A(2).toLowerCase()), false, 'excluded addresses (pools, contracts) get nothing');
  assert.ok(r.payouts.get(A(1)) > r.payouts.get(A(4)), 'longer and larger holdings get more');
});
const holderRoundRules = () => ({ equalBps: 2000, sqrtBps: 4000, proRataBps: 4000, traderCapBps: 100, capAverageMultiple: 20, minHoldSeconds: 0 });

test('the airdrop plan: qualification, linked wallets as one, carry-forward under the minimum', () => {
  const day = d => 30 * DAY + d * DAY, trades = [];
  const tr = (account, d, feeUsd) => trades.push({ account, timestamp: day(d), feeRaw: String(BigInt(Math.round(feeUsd * 1e6))), quoteDecimals: 6, asset: A(9), quoteUsd: feeUsd * 80 });
  tr(A(1), 1, 5); tr(A(1), 3, 5);           // qualifies
  tr(A(2), 1, 50);                          // one day only
  tr(A(3), 2, 2); tr(A(3), 4, 2);           // qualifies
  tr(A(4), 2, 3); tr(A(5), 5, 3);           // linked pair: two days together
  tr(A(6), 1, 0.01); tr(A(6), 2, 0.01);     // tiny: $1.6 volume, below $20
  const plan = airdropRound({ trades, start: 30 * DAY, end: 60 * DAY, usdPerUnit: () => 1, firstSeen: () => 0, pools: { [A(9)]: 1000_000_000n }, links: [[A(7), A(4)], [A(7), A(5)]], minPayoutUsd: 1 });
  const p = plan.byAsset[A(9).toLowerCase()];
  assert.ok(p.payouts.get(A(1).toLowerCase()) > 0n);
  assert.equal(p.payouts.has(A(2).toLowerCase()), false, 'one active day does not qualify');
  assert.equal(p.payouts.has(A(6).toLowerCase()), false, 'under $20 of volume does not qualify');
  assert.ok(p.payouts.get(A(4).toLowerCase()) > 0n && p.payouts.get(A(5).toLowerCase()) > 0n, 'linked wallets qualify together and share by fees');
  assert.equal(plan.qualified.length, 3);
  // A pool so small every payout is under $1: all of it carries to next month.
  const small = airdropRound({ trades, start: 30 * DAY, end: 60 * DAY, usdPerUnit: () => 1, firstSeen: () => 0, pools: { [A(9)]: 1_000_000n }, links: [], minPayoutUsd: 1 }).byAsset[A(9).toLowerCase()];
  assert.equal(small.payouts.size, 0); assert.ok(small.carried.size > 0);
});

test('only personal funders link wallets: exchanges, faucets, bridges and big fan-outs never join strangers', async () => {
  assert.equal(personalFunder({ code: '0x', nonce: 12 }), true, 'a person funding a few wallets');
  assert.equal(personalFunder({ code: '0x', nonce: 2_500_000 }), false, 'an exchange hot wallet or faucet');
  assert.equal(personalFunder({ code: '0x6080', nonce: 1 }), false, 'a contract: bridge, router, exchange batcher');
  assert.equal(personalFunder({ code: '0x', nonce: 3, ignored: true }), false, 'on the operator’s ignore list');
  const links = [...Array.from({ length: 250 }, (_, i) => [A(1), A(1000 + i)]), [A(2), A(3)], [A(2), A(4)]];
  assert.deepEqual(boundedFunderLinks(links), [[A(2), A(3)], [A(2), A(4)]], 'a funder of 250 of the month’s wallets is a service');
  // In the keeper: an exchange-like funder (many transactions) links nobody; a person links their wallets.
  const keeper = new V2Keeper({ workers: [] }), nonces = { [A(1).toLowerCase()]: 900_000, [A(2).toLowerCase()]: 4 };
  const w = { funderOf: async x => (x.endsWith('1000') || x.endsWith('1001') ? A(1) : A(2)), provider: { getCode: async () => '0x', getTransactionCount: async a => nonces[a] } };
  const found = await keeper.links(w, [A(1000), A(1001), A(3), A(4)]);
  assert.deepEqual(found, [[A(2), A(3)], [A(2), A(4)]].map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]));
});

test('the flywheel plan: independent net buying ranks tokens; creator wallets and thin tokens are left out', () => {
  const now = 100 * DAY, trades = [];
  const tr = (token, account, side, usd, ago = 600) => trades.push({ token, account, side, timestamp: now - ago, quoteRaw: String(BigInt(usd * 1e6)), tokenRaw: String(BigInt(usd * 1e6) * 1000n), asset: A(9), quoteUsd: usd });
  tr(A(100), A(1), 'buy', 50); tr(A(100), A(2), 'buy', 30); tr(A(100), A(3), 'sell', 10);
  tr(A(200), A(1), 'buy', 40); tr(A(200), A(4), 'buy', 40);
  tr(A(300), A(5), 'buy', 500); tr(A(300), A(6), 'buy', 500);       // all creator-linked
  tr(A(400), A(1), 'buy', 999);                                     // one buyer only
  const orders = flywheelOrders({ trades, now, balances: { [A(9).toLowerCase()]: 1_000_000_000n }, creatorLinkedOf: t => (t === A(300).toLowerCase() ? [A(5), A(6)] : []) });
  assert.deepEqual(orders.map(o => o.token), [A(200), A(100)].map(x => x.toLowerCase()));
  const total = orders.reduce((a, o) => a + o.amountIn, 0n);
  assert.ok(total <= 100_000_000n, 'a cycle spends at most 10% of the balance');
  for (const o of orders) { assert.equal(o.expectedOut, o.amountIn * 1000n, 'expected at the last hour’s price'); assert.equal(o.minOut, o.expectedOut * 9000n / 10_000n, 'a pool more than 10% above it is skipped'); }
});

test('the keeper runs fees, flywheel, holder rewards (USDC → native) and the monthly airdrop on the real contracts', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true }), { airdrop, holder, flywheel } = f.contracts;
  const index = new V2Indexer({ provider: f.provider, factory: f.factory.target, hook: f.hook.target, poolManager: f.manager.target, router: f.router.target });
  t.after(() => index.close());
  let chainTime = (await f.provider.getBlock('latest')).timestamp;
  const tick = async () => { chainTime = (await f.provider.getBlock('latest')).timestamp; await index.sync(); };
  const keeper = new V2Keeper({ workers: [{ chain: 'local', net: { chainId: 31337, key: 'local' }, provider: f.provider, signer: f.signers[4],
    deployment: { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target, poolManager: f.manager.target, router: f.router.target, factory: f.factory.target },
    index: () => index, usdPerUnit: a => (a === ZeroAddress.toLowerCase() ? 2500 : a === f.usdc.target.toLowerCase() ? 1 : null) }], now: () => chainTime, publicUrl: 'https://elpida.test' });
  // Two tokens: native-paired and USDC-paired. The creator sends some of the native token to a wallet (creator-linked).
  const native = await launchV2(f, { feeBps: 300, symbol: 'NAT', firstBuy: parseEther('0.2') }), usdc = await launchV2(f, { feeBps: 300, pair: 'usdc', symbol: 'USD' });
  await mined(native.token.connect(f.signers[0]).transfer(f.addresses[3], (await native.token.balanceOf(f.addresses[0])) / 2n));
  await f.advance(61);
  for (let day = 0; day < 3; day++) {
    for (const i of [1, 2]) { await trade(f, native, { signer: f.signers[i], buy: true, amount: parseEther('0.3') }); await trade(f, usdc, { signer: f.signers[i], buy: true, amount: 600n * 10n ** 6n }); }
    await trade(f, native, { signer: f.signers[3], buy: true, amount: parseEther('0.5') });
    await f.advance(DAY);
  }
  await tick();
  const w = keeper.workers[0], jump = async to => { await f.provider.send('evm_setNextBlockTimestamp', [to]); await f.provider.send('evm_mine', []); };
  // Daily: every token's shares paid into the vaults.
  await keeper.fees(w);
  for (const l of [native, usdc]) { const [owed] = await f.hook.ledgers(l.token.target); assert.deepEqual([owed[1], owed[2], owed[3]], [0n, 0n, 0n]); }
  assert.ok(await f.provider.getBalance(airdrop.target) > 0n && await f.usdc.balanceOf(holder.target) > 0n);
  // Daily flywheel: both tokens have two independent buyers; each is bought and burned within the vault's limits.
  const supplies = [await native.token.totalSupply(), await usdc.token.totalSupply()];
  await tick(); await keeper.flywheel(w);
  assert.ok(await native.token.totalSupply() < supplies[0], 'native-paired token burned');
  assert.ok(await usdc.token.totalSupply() < supplies[1], 'USDC-paired token burned with the vault’s USDC');
  // Weekly holder rewards: USDC holder shares become native, then both tokens' holders are paid in one native round.
  const hr = Number(await holder.currentRound()), usdcHeld = await f.usdc.balanceOf(holder.target);
  await jump(Number(await holder.roundEnd(hr))); await tick();
  await keeper.holder(w);
  assert.ok(await f.usdc.balanceOf(holder.target) < usdcHeld, 'the USDC share was converted');
  const hm = keeper.manifest(31337, holder.target, hr, ZeroAddress);
  assert.ok(hm, 'the holder list is published');
  assert.notEqual((await holder.rounds(hr, ZeroAddress)).root, '0x' + '0'.repeat(64));
  const holders = hm.entries.map(e => e.account.toLowerCase());
  for (const a of [f.addresses[1], f.addresses[2]]) assert.ok(holders.includes(a.toLowerCase()), 'traders holding the tokens are paid');
  for (const a of [f.addresses[0], f.addresses[3], f.manager.target]) assert.ok(!holders.includes(a.toLowerCase()), `${a} (creator, creator-linked or the pool) is not paid`);
  for (const e of hm.entries) assert.ok(verifyPayout(hm, e));
  const pushed = await f.provider.getLogs({ address: holder.target, fromBlock: 0 });
  assert.equal(pushed.map(l => { try { return holder.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === 'Claimed').length, hm.recipients, 'every holder payout was pushed');
  // Monthly airdrop: after the month ends, qualifying traders are paid in each pool asset.
  const ar = Number(await airdrop.currentRound());
  await jump(Number(await airdrop.roundEnd(ar))); await tick();
  await keeper.airdrop(w);
  for (const asset of [ZeroAddress, f.usdc.target]) {
    const m = keeper.manifest(31337, airdrop.target, ar, asset);
    assert.ok(m, `airdrop list for ${asset}`);
    const paid = m.entries.map(e => e.account.toLowerCase());
    assert.deepEqual(paid.sort(), [f.addresses[1], f.addresses[2]].map(a => a.toLowerCase()).sort(), 'the two traders qualify; creator-linked trading earns nothing');
    assert.equal((await airdrop.rounds(ar, asset)).claimed, BigInt(m.total), 'all pushed');
  }
  const st = keeper.status().chains[0];
  assert.equal(st.airdropNext, ar + 1); assert.equal(st.holderNext, hr + 1);
  assert.ok(st.runs.every(r => r.status === 'ok'), JSON.stringify(st.runs));
  // Running again does nothing new.
  await keeper.airdrop(w); await keeper.holder(w);
  assert.equal(keeper.status().chains[0].airdropNext, ar + 1);
});
