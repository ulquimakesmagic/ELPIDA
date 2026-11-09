// ELPIDA V2.0 reward contracts on a local chain (roadmap step 4): the distributor (trader airdrop by calendar month,
// holder rewards by week) and the flywheel vault, as the V2 hook's real fee recipients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress, Wallet } from 'ethers';
import { v2Fixture, launchV2, trade, revertsWith, errorSelector, parse, mined, v4Art } from './helpers/v2-fixture.mjs';
import { schedule, countdown, buildRound, verifyPayout, roundStats } from '../packages/core/v2-rounds.mjs';
import { allocateAirdrop } from '../packages/core/v2-airdrop.mjs';

const DAY = 86_400;
const jump = async (f, to) => { await f.provider.send('evm_setNextBlockTimestamp', [to]); await f.provider.send('evm_mine', []); };
const chainNow = async f => (await f.provider.getBlock('latest')).timestamp;

test('round schedules: calendar months and fixed periods match the site’s countdown exactly', async t => {
  const f = await v2Fixture(t);
  const D = (y, m) => Date.UTC(y, m - 1, 1) / 1000;
  for (const genesis of [D(2026, 11), D(2024, 1), D(2027, 12)]) {
    const c = await f.deploy(v4Art('ElpidaV2Distributor'), f.addresses[4], 0, genesis, 'trader-airdrop', ZeroAddress, ZeroAddress, ZeroAddress), s = schedule({ period: 0, genesis });
    for (let n = 0; n < 30; n++) assert.equal(Number(await c.roundStart(n)), s.start(n), `month ${n} from ${new Date(genesis * 1000).toISOString()}`);
    assert.equal(s.end(1) - s.start(1) > 27 * DAY, true);
  }
  // A leap February: 29 days.
  const leap = schedule({ period: 0, genesis: D(2028, 2) });
  assert.equal(leap.end(0) - leap.start(0), 29 * DAY);
  const week = await f.deploy(v4Art('ElpidaV2Distributor'), f.addresses[4], 7 * DAY, D(2026, 11), 'holder-rewards', ZeroAddress, ZeroAddress, ZeroAddress);
  assert.equal(Number(await week.roundEnd(3)), D(2026, 11) + 28 * DAY);
  for (const [period, genesis] of [[0, D(2026, 11) + DAY], [0, D(2026, 11) + 3600], [3600, D(2026, 11)]]) {
    await revertsWith(f.deploy(v4Art('ElpidaV2Distributor'), f.addresses[4], period, genesis, 'x', ZeroAddress, ZeroAddress, ZeroAddress), errorSelector(week, 'BadTerms'));
    assert.throws(() => schedule({ period, genesis }));
  }
  // The countdown the page shows is the contract's own round end.
  const now = await chainNow(f), monthly = await f.deploy(v4Art('ElpidaV2Distributor'), f.addresses[4], 0, D(2026, 1), 'trader-airdrop', ZeroAddress, ZeroAddress, ZeroAddress);
  const cd = countdown(schedule({ period: 0, genesis: D(2026, 1) }), now);
  assert.equal(cd.round, Number(await monthly.currentRound()));
  assert.equal(cd.endsAt, Number(await monthly.roundEnd(cd.round)));
  assert.equal(cd.days * DAY + cd.hours * 3600 + cd.minutes * 60 + cd.seconds, cd.secondsLeft);
  assert.ok(cd.progress >= 0 && cd.progress <= 1);
});

test('the trader airdrop is funded by the hook, posted after the round, and paid to every listed trader', async t => {
  const f = await v2Fixture(t, { vaults: true }), drop = f.contracts.airdrop, keeper = f.signers[4];
  const l = await launchV2(f, { feeBps: 300 });
  await f.advance(61);
  for (const [i, eth] of [[1, '2'], [2, '0.5'], [3, '0.05'], [0, '1']]) await trade(f, l, { signer: f.signers[i], buy: true, amount: parseEther(eth) });
  const [owed] = await f.hook.ledgers(l.token.target);
  await mined(f.hook.withdrawFees(l.token.target));
  const pool = await f.provider.getBalance(drop.target);
  assert.equal(pool, owed[1], 'the airdrop distributor received exactly the trader-airdrop share');
  assert.equal(await drop.available(ZeroAddress), pool);
  // This month's allocation (fees per trader in USD micro-units here; the keeper uses the indexer's figures).
  const { allocations, unallocated } = allocateAirdrop(pool, [[f.addresses[1], 75_000_000n], [f.addresses[2], 18_750_000n], [f.addresses[3], 1_875_000n], [f.addresses[0], 37_500_000n]].map(([id, fees]) => ({ id, fees })));
  const sink = await f.deploy(v4Art('RejectingReceiver'));
  allocations.set(sink.target, unallocated + 1n); allocations.set(f.addresses[0], allocations.get(f.addresses[0]) - 1n);
  const chainId = (await f.provider.getNetwork()).chainId, round = Number(await drop.currentRound());
  const m = buildRound({ chainId, distributor: drop.target, round, asset: ZeroAddress }, allocations);
  assert.equal(BigInt(m.total), pool);
  for (const e of m.entries) assert.ok(verifyPayout(m, e));
  assert.equal(await drop.leaf(round, ZeroAddress, m.entries[0].account, m.entries[0].amount), (await import('../packages/core/v2-rounds.mjs')).payoutLeaf(m, m.entries[0]));
  await revertsWith(mined(drop.connect(keeper).postRoot(round, ZeroAddress, m.root, m.total, m.recipients, 'ipfs://manifest')), errorSelector(drop, 'RoundNotOver'));
  await jump(f, Number(await drop.roundEnd(round)));
  await revertsWith(mined(drop.connect(f.signers[1]).postRoot(round, ZeroAddress, m.root, m.total, m.recipients, '')), errorSelector(drop, 'OnlyOperator'));
  await revertsWith(mined(drop.connect(keeper).postRoot(round, ZeroAddress, m.root, pool + 1n, m.recipients, '')), errorSelector(drop, 'NotFunded'));
  const posted = await mined(drop.connect(keeper).postRoot(round, ZeroAddress, m.root, m.total, m.recipients, 'ipfs://manifest'));
  assert.equal(parse(drop, posted, 'RootPosted')[0].args.recipients, 5n);
  await revertsWith(mined(drop.connect(keeper).postRoot(round, ZeroAddress, m.root, 1n, 1, '')), errorSelector(drop, 'AlreadyPosted'));
  assert.equal(await drop.available(ZeroAddress), 0n, 'everything in the pool is promised to this round');
  // The keeper pushes every payout in one transaction; the wallet that refuses is skipped and stays claimable.
  const before = await Promise.all(m.entries.map(e => f.provider.getBalance(e.account)));
  const r = await mined(drop.connect(keeper).claimMany(round, ZeroAddress, m.entries.map(e => [e.account, e.amount, e.proof])));
  assert.equal(parse(drop, r, 'Claimed').length, 4); assert.equal(parse(drop, r, 'ClaimFailed').length, 1);
  const after = await Promise.all(m.entries.map(e => f.provider.getBalance(e.account)));
  m.entries.forEach((e, i) => { if (e.account !== sink.target && e.account !== f.addresses[4]) assert.equal(after[i] - before[i], BigInt(e.amount), e.account); });
  const failed = m.entries.find(e => e.account === sink.target);
  assert.equal(await drop.reserved(ZeroAddress), BigInt(failed.amount), 'the refused payout stays reserved');
  const e0 = m.entries.find(e => e.account === f.addresses[1]);
  await revertsWith(mined(drop.claim(round, ZeroAddress, e0.account, e0.amount, e0.proof)), errorSelector(drop, 'AlreadyPaid'));
  await revertsWith(mined(drop.claim(round, ZeroAddress, e0.account, BigInt(e0.amount) + 1n, e0.proof)), errorSelector(drop, 'BadProof'));
  // Unclaimed for 12 more rounds, it returns to the pool for later rounds; nobody else can take it.
  await revertsWith(mined(drop.expire(round, ZeroAddress)), errorSelector(drop, 'RoundNotOver'));
  await jump(f, Number(await drop.roundEnd(round + 12)));
  const ex = await mined(drop.connect(f.signers[3]).expire(round, ZeroAddress));
  assert.equal(parse(drop, ex, 'Expired')[0].args.returnedToPool, BigInt(failed.amount));
  assert.equal(await drop.available(ZeroAddress), BigInt(failed.amount));
  await revertsWith(mined(drop.claim(round, ZeroAddress, failed.account, failed.amount, failed.proof)), errorSelector(drop, 'RoundClosed'));
  // Only these functions change state: nothing can send funds outside a posted round.
  const writes = drop.interface.fragments.filter(x => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability)).map(x => x.name).sort();
  assert.deepEqual(writes, ['claim', 'claimMany', 'convertToNative', 'expire', 'postRoot']);
  await revertsWith(mined(drop.connect(keeper).convertToNative(1n, 1n, 3000)), errorSelector(drop, 'BadTerms'), 'the airdrop distributor converts nothing');
  // The statistics the analytics page shows for the round.
  const stats = roundStats(m.entries.map(e => e.amount));
  assert.equal(stats.recipients, 5); assert.equal(stats.total, pool); assert.ok(stats.median > 0n && stats.top1Share > 0);
  assert.equal(stats.bands.reduce((a, b) => a + b.count, 0), 5);
});

test('holder rewards run weekly from the same contract, in the pool’s own asset (USDC here)', async t => {
  const f = await v2Fixture(t, { vaults: true }), hold = f.contracts.holder, keeper = f.signers[4];
  const l = await launchV2(f, { pair: 'usdc', feeBps: 125 });
  await f.advance(61);
  await trade(f, l, { buy: true, amount: 5_000n * 10n ** 6n });
  await mined(f.hook.withdrawFees(l.token.target));
  const pool = await f.usdc.balanceOf(hold.target);
  assert.ok(pool > 0n);
  assert.equal(await f.provider.getBalance(hold.target), 0n);
  const round = Number(await hold.currentRound()), chainId = (await f.provider.getNetwork()).chainId;
  const half = pool / 2n, m = buildRound({ chainId, distributor: hold.target, round, asset: f.usdc.target }, [[f.addresses[1], half], [f.addresses[2], pool - half]]);
  await jump(f, Number(await hold.roundEnd(round)));
  assert.equal(Number(await hold.roundEnd(round)) - Number(await hold.roundStart(round)), 7 * DAY);
  await mined(hold.connect(keeper).postRoot(round, f.usdc.target, m.root, m.total, m.recipients, ''));
  const e = m.entries[0], before = await f.usdc.balanceOf(e.account);
  await mined(hold.connect(f.signers[3]).claim(round, f.usdc.target, e.account, e.amount, e.proof));
  assert.equal(await f.usdc.balanceOf(e.account) - before, BigInt(e.amount), 'anyone may pay a listed holder');
});

test('the flywheel vault only buys V2 tokens and burns them, within its limits; the treasury never holds its funds', async t => {
  const f = await v2Fixture(t, { vaults: true }), fw = f.contracts.flywheel, keeper = f.signers[4];
  await revertsWith(mined(fw.connect(keeper).setRouter(f.router.target)), errorSelector(fw, 'BadTerms'));
  const l = await launchV2(f, { feeBps: 400 });
  await f.advance(61);
  for (let i = 0; i < 3; i++) await trade(f, l, { signer: f.signers[i + 1], buy: true, amount: parseEther('1') });
  const [owed] = await f.hook.ledgers(l.token.target), treasuryBefore = await f.provider.getBalance(f.treasury);
  await mined(f.hook.connect(f.signers[3]).withdrawFees(l.token.target));
  const pool = await f.provider.getBalance(fw.target);
  assert.equal(pool, owed[2], 'the flywheel share went straight to the vault');
  assert.equal(await f.provider.getBalance(f.treasury) - treasuryBefore, owed[4], 'the treasury received only its own 20%');
  const order = pool / 10n;
  await revertsWith(mined(fw.connect(f.signers[1]).buyAndBurn(l.token.target, order, 0n, 1)), errorSelector(fw, 'OnlyOperator'));
  await revertsWith(mined(fw.connect(keeper).buyAndBurn(l.token.target, order, 0n, 1)), errorSelector(fw, 'NotEligible'));
  await f.advance(DAY);
  await revertsWith(mined(fw.connect(keeper).buyAndBurn(l.token.target, order + 1n, 0n, 1)), errorSelector(fw, 'OrderTooLarge'));
  await revertsWith(mined(fw.connect(keeper).buyAndBurn(Wallet.createRandom().address, order, 0n, 1)), errorSelector(fw, 'NotEligible'));
  const supply = await l.token.totalSupply();
  const r = await mined(fw.connect(keeper).buyAndBurn(l.token.target, order, 1n, 7));
  const [ev] = parse(fw, r, 'BoughtAndBurned');
  assert.equal(ev.args.spent, order); assert.equal(ev.args.cycle, 7n);
  assert.equal(await l.token.totalSupply(), supply - ev.args.burned, 'a real burn: the supply fell');
  assert.equal(ev.args.supplyAfter, supply - ev.args.burned);
  assert.equal(await l.token.balanceOf(fw.target), 0n);
  assert.equal(await fw.burnedOf(l.token.target), ev.args.burned);
  await revertsWith(mined(fw.connect(keeper).buyAndBurn(l.token.target, order / 2n, 0n, 7)), errorSelector(fw, 'TooSoon'));
  await f.advance(6 * 3600);
  await mined(fw.connect(keeper).buyAndBurn(l.token.target, (await f.provider.getBalance(fw.target)) / 10n, 1n, 8));
  // Its only state-changing functions: buy-and-burn and the one-time router setting.
  const writes = fw.interface.fragments.filter(x => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability)).map(x => x.name).sort();
  assert.deepEqual(writes, ['buyAndBurn', 'setRouter']);
  // USDC-paired tokens are bought with the USDC the vault received from their own pools. (A day has passed on this
  // chain, so the mock ETH/USD feed reports a fresh price for the launch fee.)
  await mined(f.feed.set(2500n * 10n ** 8n, await chainNow(f), 2, 2));
  const u = await launchV2(f, { pair: 'usdc', feeBps: 400, symbol: 'USD' });
  await f.advance(61);
  await trade(f, u, { buy: true, amount: 20_000n * 10n ** 6n });
  await mined(f.hook.withdrawFees(u.token.target));
  await f.advance(DAY);
  const usdcPool = await f.usdc.balanceOf(fw.target), us = await u.token.totalSupply();
  const ru = await mined(fw.connect(keeper).buyAndBurn(u.token.target, usdcPool / 10n, 1n, 9));
  assert.equal(parse(fw, ru, 'BoughtAndBurned')[0].args.asset, f.usdc.target);
  assert.ok(await u.token.totalSupply() < us);
  assert.equal(await f.usdc.allowance(fw.target, f.router.target), 0n, 'no approval is left behind');
});
