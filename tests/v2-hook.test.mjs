// ELPIDA V2.0 contracts on a local chain (spec §§4–11, §17; docs/V2_0_AUDIT.md §13 step 3): the V2 token, hook and
// factory against Uniswap's own v4 PoolManager. The reference numbers come from packages/core/v2-economics.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress, Wallet } from 'ethers';
import { v2Fixture, launchV2, trade, revertsWith, errorSelector, parse, mined, v4Art, LAUNCH_FEE, NATIVE_VIRTUAL_QUOTE, ETH_USD, RECIPIENTS } from './helpers/v2-fixture.mjs';
import { poolPrice } from './helpers/v4-fixture.mjs';
import { uniswapV4Artifact } from '../scripts/compile-v4.mjs';
import { V2, splitAccrued, maxFirstBuyGross, firstBuyCapTokens, saleTokens, virtualToken } from '../packages/core/v2-economics.mjs';

const E18 = 10n ** 18n, SUPPLY = V2.tokenSupply;
/** Market cap in US dollars from the pool's sqrt price (tokens per quote unit, both with 18 decimals; ETH at $2,500). */
const mcapUsd = sqrtPrice => { const p = (Number(sqrtPrice) / 2 ** 96) ** 2; return 1e9 / p * Number(ETH_USD); };

/** Checks the hook's books for one launch: claims held = everything owed + the bonus waiting for the liquidity + the
 * split's rounding remainder (0–4 base units), and returns them. */
async function books(f, l) {
  const [owedR, paidR] = await f.hook.ledgers(l.token.target), owed = [...owedR], paid = [...paidR], info = await f.hook.launchOf(l.token.target);
  const total = await f.hook.totalOwed(l.asset), claims = await f.claims(l.asset);
  assert.equal(total, claims, 'the hook holds exactly the claims it owes');
  const reserve = total - owed.reduce((a, b) => a + b, 0n) - info.liquidityBonus;
  assert.ok(reserve >= 0n && reserve <= 4n, `five ledgers + bonus + remainder = total owed (remainder ${reserve})`);
  return { owed, paid, info, reserve };
}
const RECIPIENT_KEYS = ['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury'];

test('V2 starts at $20,000, sells 69.1% of supply on the curve and graduates at $100,000 (×5)', async t => {
  const f = await v2Fixture(t);
  assert.equal(await f.factory.nativeVirtualQuote(), NATIVE_VIRTUAL_QUOTE, '$25,000 of ETH: start × 5/4');
  assert.equal(await f.hook.VIRTUAL_TOKEN(), virtualToken());
  const l = await launchV2(f);
  const info = await f.hook.launchOf(l.token.target);
  assert.equal(info.upperTick - info.lowerTick, 16_100n);
  const start = await poolPrice(f, l);
  const startMcap = mcapUsd(start.sqrtPrice);
  assert.ok(startMcap >= 20_000 && startMcap < 20_000 * 1.001, `starts at $${startMcap.toFixed(2)}`);
  const sale = await f.hook.saleRemaining(l.token.target);
  const expected = saleTokens();
  // The launch tick is rounded to the spacing, so the sale holds within 0.01% of the exact 69.098%.
  assert.ok((sale > expected ? sale - expected : expected - sale) < expected / 10_000n, `sale position ${sale / E18} tokens`);
  await f.advance(61);
  const half = await trade(f, l, { buy: true, amount: parseEther('5') });
  assert.equal((await f.hook.launchOf(l.token.target)).graduated, false);
  assert.equal(parse(f.hook, half, 'Milestone').length, 0);
  const grad = await trade(f, l, { buy: true, amount: parseEther('10') });
  const [m] = parse(f.hook, grad, 'Milestone');
  assert.ok(m, 'the second buy crossed $100,000');
  const raised = Number(m.args.saleQuote) / 1e18 * Number(ETH_USD);
  assert.ok(raised > 30_850 && raised < 30_960, `the curve raised $${raised.toFixed(0)} into the locked pool`);
  const after = await f.hook.launchOf(l.token.target);
  assert.equal(after.graduated, true);
  // The milestone price is the lower tick: ×5.002 the launch tick.
  const gradMcap = startMcap * 1.0001 ** 16_100;
  assert.ok(gradMcap > 100_000 && gradMcap < 100_000 * 1.0035, `graduates at $${gradMcap.toFixed(0)}`);
  await books(f, l);
});

test('the creator’s first buy may receive at most 3% of the supply', async t => {
  const f = await v2Fixture(t), cap = firstBuyCapTokens();
  assert.equal(await f.hook.FIRST_BUY_CAP(), cap);
  const none = await launchV2(f, { symbol: 'NONE' });
  assert.equal(none.bought, 0n);
  const small = await launchV2(f, { symbol: 'SMALL', firstBuy: parseEther('0.1') });
  assert.ok(small.bought > 0n && small.bought < cap);
  for (const feeBps of [100, 125, 400]) {
    const max = maxFirstBuyGross({ feeBps, vQ: NATIVE_VIRTUAL_QUOTE });
    const at = await launchV2(f, { symbol: 'MAX', feeBps, firstBuy: max });
    assert.ok(at.bought <= cap && at.bought > cap * 998n / 1000n, `${feeBps} bps: ${at.bought} of ${cap}`);
    await revertsWith(launchV2(f, { symbol: 'OVER', feeBps, firstBuy: max * 1005n / 1000n }), errorSelector(f.hook, 'FirstBuyAboveCap'));
  }
  // At $20,000 the whole 3% costs about $623 at the default fee.
  const cost = Number(maxFirstBuyGross({ feeBps: 125, vQ: NATIVE_VIRTUAL_QUOTE })) / 1e18 * Number(ETH_USD);
  assert.ok(cost > 615 && cost < 630, `$${cost.toFixed(0)}`);
  // ERC-20 pairs too.
  const usdcMax = maxFirstBuyGross({ feeBps: 125, vQ: 25_000n * 10n ** 6n });
  const u = await launchV2(f, { symbol: 'USD', pair: 'usdc', firstBuy: usdcMax });
  assert.ok(u.bought <= cap && u.bought > cap * 998n / 1000n);
  await revertsWith(launchV2(f, { symbol: 'USD', pair: 'usdc', firstBuy: usdcMax * 101n / 100n }), errorSelector(f.hook, 'FirstBuyAboveCap'));
});

test('each token’s fee is chosen at launch, from the minimum to 4%, and never changes, even after graduation', async t => {
  const f = await v2Fixture(t);
  assert.equal(await f.hook.minFeeBps(), 100n); assert.equal(await f.hook.MAX_FEE_BPS(), 400n); assert.equal(await f.hook.DEFAULT_FEE_BPS(), 125n);
  for (const bad of [0, 99, 401, 9000]) await revertsWith(launchV2(f, { feeBps: bad }), errorSelector(f.hook, 'FeeOutOfRange'));
  const tokens = {};
  for (const bps of [100, 125, 250, 400]) {
    tokens[bps] = await launchV2(f, { feeBps: bps, symbol: `F${bps}` });
    assert.equal(await f.hook.feeBpsOf(tokens[bps].token.target), BigInt(bps));
    assert.equal(parse(f.factory, tokens[bps].receipt, 'Launched')[0].args.feeBps, BigInt(bps));
  }
  // Anti-snipe from 90%, then the token's own fee.
  assert.ok(await f.hook.currentFeeBps(tokens[400].token.target) > 8000n);
  await f.advance(61);
  for (const bps of [100, 125, 250, 400]) assert.equal(await f.hook.currentFeeBps(tokens[bps].token.target), BigInt(bps));
  // Graduate the 4% token: it keeps charging 4% (decision C5), not Model 11's 1%.
  const l = tokens[400];
  await trade(f, l, { buy: true, amount: parseEther('16') });
  assert.equal((await f.hook.launchOf(l.token.target)).graduated, true);
  assert.equal(await f.hook.currentFeeBps(l.token.target), 400n);
  const r = await trade(f, l, { buy: false, amount: (await l.token.balanceOf(f.addresses[1])) / 10n });
  const [fee] = parse(f.hook, r, 'Fee');
  assert.equal(fee.args.feeBps, 400n); assert.equal(fee.args.lockedBonus, 0n);
  // Nothing can change a fee: no setter exists on the hook or the factory.
  for (const c of [f.hook, f.factory]) {
    const writes = c.interface.fragments.filter(x => x.type === 'function' && !x.constant && x.stateMutability !== 'view' && x.stateMutability !== 'pure').map(x => x.name);
    assert.ok(!writes.some(n => /fee/i.test(n) && !/^(withdrawFees|_?claim)$/.test(n)), writes.join(', '));
  }
});

test('every fee splits 30/30/10/10/20, exactly, and the hook’s claims match after every trade', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { feeBps: 250, firstBuy: parseEther('0.05') });
  let accrued = 0n;
  const record = receipt => { for (const fe of parse(f.hook, receipt, 'Fee')) accrued += fe.args.fee - fe.args.lockedBonus; };
  const expectBooks = async (extra = 0n, label = '') => {
    const b = await books(f, l), want = splitAccrued(accrued, extra);
    assert.equal(b.info.accrued, accrued, `running total ${label}`);
    assert.deepEqual(b.owed.map((x, i) => x + b.paid[i]), RECIPIENT_KEYS.map(k => want[k]), `shares ${label}`);
    assert.equal(b.reserve, want.reserve);
    return b;
  };
  record(l.receipt);
  let b = await expectBooks(0n, 'after launch');
  // Trades inside the anti-snipe window, then normal ones, buys and sells of uneven sizes.
  const seq = [['buy', '0.3'], ['buy', '0.0000123'], ['sell', 0.5], ['wait'], ['buy', '1.7'], ['sell', 0.33], ['buy', '0.9'], ['sell', 0.1]];
  for (const [side, amount] of seq) {
    if (side === 'wait') { await f.advance(61); continue; }
    const r = side === 'buy'
      ? await trade(f, l, { buy: true, amount: parseEther(amount) })
      : await trade(f, l, { buy: false, amount: (await l.token.balanceOf(f.addresses[1])) * BigInt(Math.round(amount * 100)) / 100n });
    record(r);
    b = await expectBooks(0n, `after ${side} ${amount}`);
  }
  assert.ok(b.info.liquidityBonus > 0n, 'the anti-snipe surplus waits for the locked liquidity');
  // A recipient paid mid-way keeps earning from where it was.
  await mined(f.hook.claim(l.token.target, 2));
  b = await expectBooks(0n, 'after the flywheel was paid');
  assert.equal(b.owed[2], 0n);
  // Graduate: the bonus joins the locked liquidity; the milestone's rounding dust goes to the treasury.
  const g = await trade(f, l, { buy: true, amount: parseEther('16') });
  record(g);
  const [m] = parse(f.hook, g, 'Milestone');
  b = await expectBooks(m.args.dust, 'after the milestone');
  assert.equal(b.info.liquidityBonus, 0n);
  // Anyone pays all five; each recipient receives exactly what it is owed.
  const owedNow = b.owed;
  const before = await Promise.all(RECIPIENT_KEYS.map(r => f.provider.getBalance(f.recipient(l, r))));
  const w = await mined(f.hook.connect(f.signers[3]).withdrawFees(l.token.target));
  assert.equal(parse(f.hook, w, 'FeesWithdrawn').length, 5, 'the flywheel earned again from the graduating buy');
  const after = await Promise.all(RECIPIENT_KEYS.map(r => f.provider.getBalance(f.recipient(l, r))));
  assert.deepEqual(after.map((x, i) => x - before[i]), owedNow);
  b = await expectBooks(m.args.dust, 'after payouts');
  assert.deepEqual(b.owed, [0n, 0n, 0n, 0n, 0n]);
  assert.equal(await f.claims(ZeroAddress), b.reserve, 'only the rounding remainder stays');
  const want = splitAccrued(accrued, m.args.dust);
  assert.equal(want.creator, want.traderAirdrop); assert.equal(want.flywheel, want.holderRewards);
  assert.equal(want.creator * 10n / accrued, 2n); // 30% rounded down to tenths
});

test('a paused stock quote suspends trading and payouts but keeps every entitlement (spec §17)', async t => {
  const f = await v2Fixture(t);
  await mined(f.factory.connect(f.owner).approveQuote(f.stock.target, parseEther('100')));
  const l = await launchV2(f, { pair: 'stock', firstBuy: parseEther('1'), symbol: 'STK' });
  await f.advance(61);
  await trade(f, l, { buy: true, amount: parseEther('2') });
  await trade(f, l, { buy: false, amount: (await l.token.balanceOf(f.addresses[1])) / 3n });
  const owed = (await books(f, l)).owed;
  assert.ok(owed.every(x => x > 0n));
  await mined(f.stock.connect(f.signers[0]).pause());
  await revertsWith(trade(f, l, { buy: true, amount: parseEther('1') }), 'paused');
  const failed = await mined(f.hook.withdrawFees(l.token.target));
  assert.equal(parse(f.hook, failed, 'FeePayoutFailed').length, 5, 'every payout waits');
  assert.deepEqual((await books(f, l)).owed, owed, 'nothing is lost or swapped for another asset');
  await mined(f.stock.connect(f.signers[0]).unpause());
  const paid = await mined(f.hook.withdrawFees(l.token.target));
  assert.equal(parse(f.hook, paid, 'FeesWithdrawn').length, 5);
  assert.equal(await f.stock.balanceOf(f.vaults.flywheel), owed[2]);
  await trade(f, l, { buy: true, amount: parseEther('1') });
});

test('the liquidity stays locked: nobody can add to or create a V2 pool', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f);
  await revertsWith(mined(f.liquidityRouter.modifyLiquidity(l.key, [-887270, 887270, 10n ** 18n, '0x' + '00'.repeat(32)], '0x', { value: parseEther('1') })), errorSelector(f.hook, 'LiquidityLocked'));
  await revertsWith(mined(f.manager.initialize([ZeroAddress, l.token.target, 0, 60, f.hook.target], 2n ** 96n)), errorSelector(f.hook, 'OnlyElpida'));
  await revertsWith(mined(f.hook.launch(l.token.target, ZeroAddress, f.addresses[0], f.addresses[0], 1n, 125, 0, 0)), errorSelector(f.hook, 'OnlyElpida'));
});

test('tickers are 1–10 ASCII letters or digits and may repeat; launch fee is $10 in ETH or 10 USDC', async t => {
  const f = await v2Fixture(t);
  const a = await launchV2(f, { symbol: 'HOPE' }), b = await launchV2(f, { symbol: 'HOPE' }), c = await launchV2(f, { symbol: 'h0pe2026ab' });
  assert.notEqual(a.token.target, b.token.target, 'duplicate tickers are separate tokens');
  assert.equal(await c.token.symbol(), 'h0pe2026ab');
  for (const bad of ['', 'ELEVENCHARS', 'HO PE', 'HOPE!', '$HOPE', 'ÉLP']) await revertsWith(launchV2(f, { symbol: bad }), 'ticker');
  await revertsWith(launchV2(f, { name: '' }), 'name length');
  assert.equal(await f.factory.launchFee(), LAUNCH_FEE);
  const eth = await f.provider.getBalance(f.treasury);
  await launchV2(f, { symbol: 'ETHFEE' });
  assert.equal(await f.provider.getBalance(f.treasury) - eth, LAUNCH_FEE);
  const usd = await f.usdc.balanceOf(f.treasury);
  await launchV2(f, { symbol: 'USDFEE', inUsdc: true });
  assert.equal(await f.usdc.balanceOf(f.treasury) - usd, 10n * 10n ** 6n);
  assert.equal(await f.factory.MODEL_VERSION(), 20n); assert.equal(await f.factory.testSized(), false);
});

test('V2 tokens burn for real: launch dust and donations leave the supply, and holders can burn', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { firstBuy: parseEther('0.2') });
  const dust = l.launched.dustBurned;
  assert.equal(await l.token.totalSupply(), SUPPLY - dust);
  assert.equal(await l.token.balanceOf('0x000000000000000000000000000000000000dEaD'), 0n);
  const holder = l.token.connect(f.signers[0]), mine = await holder.balanceOf(f.addresses[0]);
  const r = await mined(holder.burn(mine / 2n));
  assert.equal(await l.token.totalSupply(), SUPPLY - dust - mine / 2n);
  const [ev] = parse(l.token, r, 'Transfer');
  assert.equal(ev.args.to, ZeroAddress);
  await mined(holder.approve(f.addresses[1], 5n));
  await mined(l.token.connect(f.signers[1]).burnFrom(f.addresses[0], 5n));
  await revertsWith(mined(l.token.connect(f.signers[1]).burnFrom(f.addresses[0], 1n)), 'allowance');
  // A donation of tokens to the pool comes out with the sale position at the milestone and is burned, not parked.
  const donor = await f.deploy(uniswapV4Artifact('PoolDonateTest'), f.manager.target);
  await mined(holder.approve(donor.target, 1000n * E18));
  await mined(donor.connect(f.signers[0]).donate(l.key, 0n, 1000n * E18, '0x'));
  const supply = await l.token.totalSupply();
  await f.advance(61);
  const g = await trade(f, l, { buy: true, amount: parseEther('16') });
  const [m] = parse(f.hook, g, 'Milestone');
  assert.ok(m.args.tokensBurned > 999n * E18 && m.args.tokensBurned <= 1000n * E18, `${m.args.tokensBurned}`);
  assert.equal(await l.token.totalSupply(), supply - m.args.tokensBurned);
  assert.equal(await l.token.balanceOf(f.hook.target), 0n);
});

test('the Elpida router quotes and trades V2 tokens; contracts fit the EVM size limit', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { feeBps: 200 });
  await f.advance(61);
  const [, out] = await f.router.quote.staticCall(l.token.target, true, parseEther('0.5'));
  const before = await l.token.balanceOf(f.addresses[1]);
  const r = await trade(f, l, { buy: true, amount: parseEther('0.5') });
  assert.equal(await l.token.balanceOf(f.addresses[1]) - before, out, 'the quote is the trade');
  assert.equal(parse(f.hook, r, 'Fee')[0].args.fee, parseEther('0.5') * 200n / 10_000n);
  for (const name of ['ElpidaV2Hook', 'ElpidaV2Factory', 'ElpidaV2Token']) assert.ok(v4Art(name).evm.deployedBytecode.object.length / 2 <= 24_576, name);
  assert.ok(await f.provider.getCode(Wallet.createRandom().address) === '0x');
});
