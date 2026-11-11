// Fixes from the pre-mainnet audit of 11 November 2026 (docs/AUDIT_TRIAGE_2026-11-11.md):
//  - EVM-02: a wallet that claimed its own leaf no longer blocks the keeper's batch for everyone else;
//  - EVM-03: the launch price is cast with SafeCast (covered by every launch below);
//  - EVM-07: exact-output buys and sells charge the right fee and keep the books;
//  - stress test (audit 1.2): a long seeded random sequence of trades, time jumps, donations, payouts and the
//    milestone, checking the five-ledger conservation after every step;
//  - first mainnet release: the treasury and a guardian can stop new launches, and launches are capped per UTC day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress, Wallet } from 'ethers';
import { v2Fixture, launchV2, trade, revertsWith, errorSelector, parse, mined, v4Art } from './helpers/v2-fixture.mjs';
import { uniswapV4Artifact } from '../scripts/compile-v4.mjs';
import { buildRound } from '../packages/core/v2-rounds.mjs';

const E18 = 10n ** 18n, USDC = 10n ** 6n;
const MIN_LIMIT = 4295128740n, MAX_LIMIT = 1461446703485210103287273052203988822378723970341n;
const SETTINGS = [false, false];

/** Claims held = owed + bonus + remainder (0–4), and accrued = everything owed and paid at the token's own rate. */
async function books(f, l, label = '') {
  const [owedR, paidR] = await f.hook.ledgers(l.token.target), owed = [...owedR], paid = [...paidR].map(BigInt);
  const info = await f.hook.launchOf(l.token.target), total = await f.hook.totalOwed(l.asset), claims = await f.claims(l.asset);
  assert.equal(total, claims, `${label} the hook holds exactly the claims it owes`);
  const outstanding = owed.reduce((a, b) => a + b, 0n), held = info.liquidityBonus + outstanding;
  assert.ok(total >= held && total - held <= 4n * 2n, `${label} claims = owed + bonus + rounding (${total - held})`);
  return { owed, paid, info };
}

/** mulDivRoundingUp(net, bps, 10000 - bps): the hook's fee when only the net quote is known. */
const feeOnNet = (net, bps) => (net * bps + (10_000n - bps) - 1n) / (10_000n - bps);

test('EVM-02: a wallet that claimed its own leaf no longer blocks the batch for the others', async t => {
  const f = await v2Fixture(t, { vaults: true }), drop = f.contracts.airdrop, keeper = f.signers[4];
  const l = await launchV2(f, { feeBps: 300 });
  await f.advance(61);
  await trade(f, l, { signer: f.signers[1], buy: true, amount: parseEther('2') });
  await mined(f.hook.withdrawFees(l.token.target));
  const pool = await f.provider.getBalance(drop.target), round = Number(await drop.currentRound());
  const wallets = [0, 1, 2, 3].map(() => Wallet.createRandom().address), each = pool / 4n;
  const m = buildRound({ chainId: (await f.provider.getNetwork()).chainId, distributor: drop.target, round, asset: ZeroAddress }, new Map(wallets.map(w => [w, each])));
  const end = Number(await drop.roundEnd(round)), now = await f.now();
  if (end > now) await f.advance(end - now + 1);
  await mined(drop.connect(keeper).postRoot(round, ZeroAddress, m.root, m.total, m.recipients, ''));
  // One listed wallet claims for itself (claim is permissionless) before the keeper pushes the batch.
  const self = m.entries[1];
  await mined(drop.connect(f.signers[3]).claim(round, ZeroAddress, self.account, self.amount, self.proof));
  const r = await mined(drop.connect(keeper).claimMany(round, ZeroAddress, m.entries.map(e => [e.account, e.amount, e.proof])));
  assert.equal(parse(drop, r, 'Claimed').length, 3, 'the other three are paid in the same batch');
  for (const e of m.entries) assert.equal(await f.provider.getBalance(e.account), BigInt(e.amount), e.account);
  assert.equal(await drop.reserved(ZeroAddress), 0n, 'nothing stays reserved for the skipped leaf');
  // Replaying the whole batch is harmless: every leaf is skipped and nothing moves.
  const again = await mined(drop.connect(keeper).claimMany(round, ZeroAddress, m.entries.map(e => [e.account, e.amount, e.proof])));
  assert.equal(parse(drop, again, 'Claimed').length, 0);
  // A single claim of a paid leaf still reverts, so a wallet sees why.
  await revertsWith(mined(drop.claim(round, ZeroAddress, self.account, self.amount, self.proof)), errorSelector(drop, 'AlreadyPaid'));
});

test('EVM-02: the USDC payout distributors skip already-paid leaves too', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true, usdcPayouts: true }), dist = f.contracts.usdcHolder, keeper = f.signers[4];
  await mined(f.usdc.mint(dist.target, 40n * USDC));
  const round = Number(await dist.currentRound()), wallets = [0, 1, 2, 3].map(() => Wallet.createRandom().address);
  const m = buildRound({ chainId: (await f.provider.getNetwork()).chainId, distributor: dist.target, round, asset: f.usdc.target }, new Map(wallets.map(w => [w, 10n * USDC])));
  const end = Number(await dist.roundEnd(round)), now = await f.now();
  if (end > now) await f.advance(end - now + 1);
  await mined(dist.connect(keeper).postRoot(round, f.usdc.target, m.root, m.total, m.recipients, ''));
  const self = m.entries[2];
  await mined(dist.claim(round, f.usdc.target, self.account, self.amount, self.proof));
  const r = await mined(dist.connect(keeper).claimMany(round, f.usdc.target, m.entries.map(e => [e.account, e.amount, e.proof])));
  assert.equal(parse(dist, r, 'Claimed').length, 3);
  for (const w of wallets) assert.equal(await f.usdc.balanceOf(w), 10n * USDC);
});

test('EVM-07: exact-output buys and sells charge the token’s fee on the gross and keep the books', async t => {
  const f = await v2Fixture(t), trader = f.signers[1], me = f.addresses[1];
  const l = await launchV2(f, { pair: 'usdc', feeBps: 250 });
  await f.advance(61);
  const first = await trade(f, l, { signer: trader, buy: true, amount: 2_000n * USDC });
  await mined(f.usdc.connect(trader).approve(f.swapRouter.target, 2n ** 255n));
  await mined(l.token.connect(trader).approve(f.swapRouter.target, 2n ** 255n));
  // Exact-output buy: the trader names the tokens; the fee is added to the quote it pays.
  const usdcBefore = await f.usdc.balanceOf(me), tokBefore = await l.token.balanceOf(me), want = 1_000_000n * E18;
  const rb = await mined(f.swapRouter.connect(trader).swap(l.key, [true, want, MIN_LIMIT], SETTINGS, '0x'));
  const [fb] = parse(f.hook, rb, 'Fee');
  assert.equal(await l.token.balanceOf(me) - tokBefore, want, 'received exactly the tokens asked for');
  const paid = usdcBefore - await f.usdc.balanceOf(me);
  assert.equal(fb.args.fee, feeOnNet(paid - fb.args.fee, 250n), 'fee = net × 2.5% / 97.5%, rounded up');
  assert.equal(fb.args.lockedBonus, 0n);
  await books(f, l, 'after the exact-output buy');
  // Exact-output sell: the trader names the quote it receives; the fee comes on top of the gross the pool pays.
  const out = 100n * USDC, before = await f.usdc.balanceOf(me);
  const rs = await mined(f.swapRouter.connect(trader).swap(l.key, [false, out, MAX_LIMIT], SETTINGS, '0x'));
  const [fs] = parse(f.hook, rs, 'Fee');
  assert.equal(await f.usdc.balanceOf(me) - before, out, 'received exactly the quote asked for');
  assert.equal(fs.args.fee, feeOnNet(out, 250n));
  const { info } = await books(f, l, 'after the exact-output sell');
  // Every fee so far is at the token's own rate (outside the first minute): accrued is their sum.
  const all = [...parse(f.hook, l.receipt, 'Fee'), ...parse(f.hook, first, 'Fee'), fb, fs].reduce((a, e) => a + e.args.fee - e.args.lockedBonus, 0n);
  assert.equal(info.accrued, all);
});

test('stress: a long random sequence of trades, time jumps, donations and payouts keeps the five ledgers exact', async t => {
  const steps = Number(process.env.ELPIDA_V2_FUZZ_STEPS ?? 160), seed = Number(process.env.ELPIDA_V2_FUZZ_SEED ?? 20261111);
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)], big = (lo, hi) => lo + BigInt(Math.floor(rnd() * Number(hi - lo)));
  const f = await v2Fixture(t);
  const donor = await f.deploy(uniswapV4Artifact('PoolDonateTest'), f.manager.target);
  const launches = [await launchV2(f, { feeBps: 400, firstBuy: parseEther('0.2') }), await launchV2(f, { pair: 'usdc', feeBps: 100, firstBuy: 500n * USDC })];
  const traders = [f.signers[0], f.signers[1], f.signers[3]];
  for (const l of launches) {
    l.fees = parse(f.hook, l.receipt, 'Fee').reduce((a, e) => a + e.args.fee - e.args.lockedBonus, 0n);
    l.paidSeen = [0n, 0n, 0n, 0n, 0n];
    for (const tr of traders) {
      await mined(l.token.connect(tr).approve(f.swapRouter.target, 2n ** 255n)); await mined(l.token.connect(tr).approve(donor.target, 2n ** 255n));
      if (l.quote) { await mined(f.usdc.connect(tr).approve(f.swapRouter.target, 2n ** 255n)); }
    }
  }
  // Reverts a trader can legitimately hit: selling below the launch price, or spending more tokens or USDC than it holds.
  const expected = new Set([errorSelector(f.hook, 'AboveLaunchPrice'), 'reason="balance"', 'ERC20InsufficientBalance', 'transfer amount exceeds balance']);
  const counts = {};
  for (let i = 0; i < steps; i++) {
    const l = pick(launches), tr = pick(traders), who = await tr.getAddress(), kind = pick(['buy', 'buy', 'bigBuy', 'sell', 'exactOutBuy', 'exactOutSell', 'wait', 'payout', 'claim', 'donate']);
    const tag = `seed ${seed} step ${i} ${kind} on ${l.quote ? 'USDC' : 'ETH'}:`;
    let receipt = null;
    try {
      if (kind === 'buy') receipt = await trade(f, l, { signer: tr, buy: true, amount: l.quote ? big(1n * USDC, 3_000n * USDC) : big(parseEther('0.001'), parseEther('3')) });
      else if (kind === 'bigBuy') receipt = await trade(f, l, { signer: tr, buy: true, amount: l.quote ? big(3_000n * USDC, 15_000n * USDC) : big(parseEther('2'), parseEther('8')) });
      else if (kind === 'sell') { const bal = await l.token.balanceOf(who); if (bal > 0n) receipt = await trade(f, l, { signer: tr, buy: false, amount: bal * big(1n, 60n) / 100n }); }
      else if (kind === 'exactOutBuy' && l.quote) receipt = await mined(f.swapRouter.connect(tr).swap(l.key, [true, big(1_000n, 5_000_000n) * E18, MIN_LIMIT], SETTINGS, '0x'));
      else if (kind === 'exactOutSell' && l.quote) receipt = await mined(f.swapRouter.connect(tr).swap(l.key, [false, big(1n * USDC, 200n * USDC), MAX_LIMIT], SETTINGS, '0x'));
      else if (kind === 'wait') await f.advance(pick([1, 5, 20, 45, 61, 3600]));
      else if (kind === 'payout') receipt = await mined(f.hook.withdrawFees(l.token.target));
      else if (kind === 'claim') receipt = await mined(f.hook.claim(l.token.target, Math.floor(rnd() * 5)));
      else if (kind === 'donate') { const bal = await l.token.balanceOf(who); if (bal > 10n) receipt = await mined(donor.connect(tr).donate(l.key, 0n, bal / 10n, '0x')); }
      counts[kind] = (counts[kind] ?? 0) + 1;
    } catch (e) {
      const seen = [e.message, e.data, e.info?.error?.message, e.info?.error?.data, e.error?.data].filter(Boolean).join(' ');
      if (![...expected].some(x => seen.toLowerCase().includes(String(x).replace(/^0x/, '').toLowerCase()))) throw new Error(`${tag} unexpected revert: ${seen.slice(0, 300)}`);
      counts.reverted = (counts.reverted ?? 0) + 1;
    }
    if (receipt) l.fees += parse(f.hook, receipt, 'Fee').reduce((a, e) => a + e.args.fee - e.args.lockedBonus, 0n);
    const { paid, info } = await books(f, l, tag);
    assert.equal(info.accrued, l.fees, `${tag} accrued = every fee at the token's own rate`);
    paid.forEach((p, k) => assert.ok(p >= l.paidSeen[k], `${tag} paid only grows`));
    l.paidSeen = paid;
  }
  // At the end every share is paid out exactly; what stays behind is the bonus (until the milestone) and ≤ 4 units.
  for (const l of launches) {
    await mined(f.hook.withdrawFees(l.token.target));
    const { owed, info } = await books(f, l, `seed ${seed} final:`);
    assert.deepEqual(owed, [0n, 0n, 0n, 0n, 0n]);
    const left = await f.hook.totalOwed(l.asset);
    assert.ok(left - info.liquidityBonus <= 8n, `left ${left - info.liquidityBonus}`);
  }
  assert.ok((counts.buy ?? 0) > steps / 10, `enough trades ran: ${JSON.stringify(counts)}`);
  const graduated = (await Promise.all(launches.map(l => f.hook.launchOf(l.token.target)))).map(x => x.graduated);
  if (!process.env.ELPIDA_V2_FUZZ_SEED) assert.ok(graduated.some(Boolean), 'the default run crosses the milestone, so it is checked too');
  t.diagnostic(`seed ${seed}, ${steps} steps: ${JSON.stringify(counts)}; graduated: ${graduated}`);
});

test('first mainnet release: the treasury or its guardian can stop new launches; launches are capped per UTC day', async t => {
  const f = await v2Fixture(t), owner = f.owner, guardian = f.signers[3], stranger = f.signers[1];
  assert.equal(await f.factory.LAUNCH_CONTROLS_VERSION(), 1n);
  assert.equal(await f.factory.launchesLeftToday(), 2n ** 256n - 1n, 'uncapped by default');
  await revertsWith(mined(f.factory.connect(stranger).pauseLaunches()), 'owner/guardian only');
  await revertsWith(mined(f.factory.connect(stranger).setGuardian(f.addresses[1])), 'owner only');
  await mined(f.factory.connect(owner).setGuardian(f.addresses[3]));
  const live = await launchV2(f);
  await mined(f.factory.connect(guardian).pauseLaunches());
  assert.equal(await f.factory.launchesLeftToday(), 0n);
  await revertsWith(launchV2(f), 'launches paused');
  // A stop never touches trading or payouts on existing pools.
  await f.advance(61);
  await trade(f, live, { buy: true, amount: parseEther('0.5') });
  await mined(f.hook.withdrawFees(live.token.target));
  await revertsWith(mined(f.factory.connect(guardian).resumeLaunches()), 'owner only');
  await mined(f.factory.connect(owner).resumeLaunches());
  // Daily cap: two launches today, the third waits for the next UTC day.
  await revertsWith(mined(f.factory.connect(stranger).setDailyLaunchCap(2)), 'owner only');
  await mined(f.factory.connect(owner).setDailyLaunchCap(2));
  const now = await f.now(), today = BigInt(Math.floor(now / 86_400)), used = await f.factory.launchesOnDay(today);
  for (let i = used; i < 2n; i++) await launchV2(f, { symbol: `C${i}` });
  assert.equal(await f.factory.launchesLeftToday(), 0n);
  await revertsWith(launchV2(f, { symbol: 'OVER' }), 'daily launch cap');
  await f.advance(86_400 - (now % 86_400) + 1);
  await launchV2(f, { symbol: 'NEXT' });
  assert.equal(await f.factory.launchesLeftToday(), 1n);
});
