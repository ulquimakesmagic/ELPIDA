// ELPIDA V2.0 launchpad (contracts/evm/v2) on a local cancun chain against Uniswap's own v4 PoolManager. Checks the
// V2.0 acceptance rules on chain: $20k start, x5 milestone, per-token fee 1-4% fixed for life and charged after the
// milestone, the 30/30/10/10/20 split, the 3% first-buy cap, real burns and the liquidity lock. Nothing is deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress } from 'ethers';
import { uniswapV4Artifact } from '../scripts/compile-v4.mjs';
import { swap, poolPrice, parse, delta, mined, v4Art } from './helpers/v4-fixture.mjs';
import { v2Fixture, launchV2, afterWindow, MIN_FEE_BPS, USDC_VIRTUAL_QUOTE } from './helpers/v2-fixture.mjs';
import { Q96, sqrtPriceAtTick } from './helpers/model10-reference.mjs';
import { saleTokens, splitFee, maxFirstBuyGross, firstBuyCapTokens, virtualToken } from '../packages/core/v2-economics.mjs';

const SUPPLY = 10n ** 27n, DEAD = '0x000000000000000000000000000000000000dEaD';
const relNear = (a, b, ppb, message) => assert.ok((a > b ? a - b : b - a) * 1_000_000_000n <= b * ppb, `${message}: ${a} vs ${b}`);
const ledgerSum = g => g.creator + g.airdrop + g.flywheel + g.holders + g.treasury;
const asSplit = g => ({ creator: g.creator, traderAirdrop: g.airdrop, flywheel: g.flywheel, holderRewards: g.holders, treasury: g.treasury });

test('V2 launch: $20k start (never cheaper), x5 sale range, whole supply in the pool, dust really burned, no way out for principal', async t => {
  const f = await v2Fixture(t);
  assert.equal(f.virtualQuote, parseEther('10'), '$20,000 x 5/4 at $2,500 per ETH');
  const l = await launchV2(f);
  const { upperTick, lowerTick, saleLiquidity: L, feeBps } = l.launched;
  assert.equal(feeBps, 125n);
  assert.equal(upperTick - lowerTick, 16_100n);
  const sqrtU = sqrtPriceAtTick(upperTick), sqrtL = sqrtPriceAtTick(lowerTick);
  assert.equal((await poolPrice(f, l)).sqrtPrice, sqrtU);
  const vT = virtualToken(), p0 = vT * Q96 * Q96 / f.virtualQuote, p = sqrtU * sqrtU;
  assert.ok(p <= p0 && (p0 - p) * 1000n <= p0, 'within 0.1% of $20,000, never cheaper');
  // The 16,100-tick range ends at 5.002x, so the sale is a hair larger than the exact x5 reference (69.1% of supply).
  const sale = L * (sqrtU - sqrtL) / Q96;
  relNear(sale, saleTokens(), 1_000_000n, 'sale tokens vs v2-economics');
  const dust = l.launched.dustBurned;
  assert.ok(dust < 10n ** 6n);
  assert.equal(await l.token.totalSupply(), SUPPLY - dust, 'dust is burned: total supply falls');
  assert.equal(await l.token.balanceOf(DEAD), 0n, 'nothing is parked at the dead address');
  assert.equal(await l.token.balanceOf(f.manager.target), SUPPLY - dust);
  const writes = f.hook.interface.fragments.filter(x => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability) && !/^(before|after)/.test(x.name)).map(x => x.name).sort();
  assert.deepEqual(writes, ['claimFees', 'launch', 'openLiquidity', 'payoutStep', 'unlockCallback', 'withdrawFees'], 'no fee setter, no principal removal');
  assert.equal(await f.hook.getHookPermissions().then(p => p.beforeRemoveLiquidity || p.afterRemoveLiquidity), false);
  await assert.rejects(f.liquidityRouter.connect(f.signers[1])['modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)'](l.key, [-887270, 887270, 10n ** 15n, '0x' + '00'.repeat(32)], '0x', { value: parseEther('1') }));
});

test('V2 fee range: the minimum to exactly 4% launch; outside it reverts; the fee is fixed and applies after anti-snipe', async t => {
  const f = await v2Fixture(t);
  assert.equal(await f.hook.minFeeBps(), BigInt(MIN_FEE_BPS));
  for (const bad of [0, MIN_FEE_BPS - 1, 401, 1000]) await assert.rejects(f.factory.launch.staticCall('Bad', 'BAD', bad, 0n, 0n, f.addresses[0], { value: parseEther('0.004') }), /fee range/, `${bad} bps`);
  for (const fee of [MIN_FEE_BPS, 125, 400]) {
    const l = await launchV2(f, { feeBps: fee, symbol: `F${fee}` });
    assert.equal((await f.hook.launches(l.token.target)).feeBps, BigInt(fee));
    const early = await f.hook.currentFeeBps(l.token.target);
    assert.ok(early > BigInt(fee) * 10n && early <= 9000n, `anti-snipe starts near 90% (${early})`);
    await afterWindow(f, l);
    assert.equal(await f.hook.currentFeeBps(l.token.target), BigInt(fee), 'then the chosen fee');
  }
});

test('V2 tickers: 1-10 ASCII letters or digits on chain; duplicates launch with no surcharge', async t => {
  const f = await v2Fixture(t);
  for (const bad of ['', 'ABCDEFGHIJK', 'PE PE', 'PEPE!']) await assert.rejects(f.factory.launch.staticCall('Name', bad, 125, 0n, 0n, f.addresses[0], { value: parseEther('0.004') }), `ticker "${bad}"`);
  const treasuryBefore = await f.provider.getBalance(f.treasury);
  const a = await launchV2(f, { symbol: 'HOPE' }), b = await launchV2(f, { symbol: 'HOPE', signer: f.signers[1] });
  assert.notEqual(a.token.target, b.token.target);
  assert.equal(await f.provider.getBalance(f.treasury) - treasuryBefore, parseEther('0.008'), 'two launches, $10 each, nothing extra for the duplicate');
});

test('V2 five-way split: every trade credits 30/30/10/10/20 exactly; each recipient is paid its own ledger', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { feeBps: 250 });
  await afterWindow(f, l);
  let expected = splitFee(0n);
  const add = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]]));
  for (const [buy, amount] of [[true, parseEther('1.2345')], [true, parseEther('0.7') + 3n], [false, null], [true, 999_999n]]) {
    const held = await l.token.balanceOf(f.addresses[1]);
    const r = await swap(f, l, { buy, amount: amount ?? held / 3n });
    const [fee] = parse(f.hook, r, 'Fee'), [s] = parse(f.hook, r, 'FeeSplit');
    assert.equal(fee.args.feeBps, 250n);
    if (buy) assert.equal(fee.args.fee, amount * 250n / 10_000n, 'exact-input buy: fee on the gross quote');
    const want = splitFee(fee.args.fee);
    assert.deepEqual({ creator: s.args.creator, traderAirdrop: s.args.airdrop, flywheel: s.args.flywheel, holderRewards: s.args.holders, treasury: s.args.treasury }, want);
    expected = add(expected, want);
  }
  const g = await f.hook.ledgers(l.token.target);
  assert.deepEqual(asSplit(g), expected);
  assert.equal(await f.hook.totalOwed(ZeroAddress), ledgerSum(g), 'the hook owes exactly its ledgers');
  const balances = () => Promise.all([f.addresses[0], f.airdrop, f.flywheel, f.holders, f.treasury].map(a => f.provider.getBalance(a)));
  const before = await balances();
  const r = await mined(f.hook.connect(f.signers[3]).withdrawFees(l.token.target));
  const after = await balances();
  assert.equal(after[1] - before[1], g.airdrop); assert.equal(after[2] - before[2], g.flywheel);
  assert.equal(after[3] - before[3], g.holders); assert.equal(after[4] - before[4], g.treasury);
  assert.equal(parse(f.hook, r, 'FeesWithdrawn').length, 5);
  assert.equal(await f.hook.totalOwed(ZeroAddress), 0n);
  await assert.rejects(f.hook.claimFees(l.token.target, f.addresses[4]), /fee recipient/, 'nobody else can be paid');
});

test('V2 first buy: zero is valid; up to 3% of supply launches; above 3% reverts and charges nothing', async t => {
  const f = await v2Fixture(t);
  const zero = await launchV2(f, { firstBuy: 0n });
  assert.equal(zero.bought, 0n);
  for (const feeBps of [100, 125, 400]) {
    const max = maxFirstBuyGross({ feeBps, vQ: f.virtualQuote });
    const l = await launchV2(f, { feeBps, firstBuy: max, symbol: `M${feeBps}` });
    assert.ok(l.bought > 0n && l.bought <= firstBuyCapTokens(), `bought ${l.bought}`);
    // The pool's start rounds to the tick spacing (<= 0.1% dearer), so the reference maximum buys a little under 3%.
    assert.ok(l.bought * 1000n >= firstBuyCapTokens() * 998n, 'and close to it');
    assert.equal((await f.hook.ledgers(l.token.target)).creator, splitFee(max * BigInt(feeBps) / 10_000n).creator, 'the first buy pays the chosen fee once');
    const treasury = await f.provider.getBalance(f.treasury);
    await assert.rejects(mined(f.factory.launch('Big', 'BIG', feeBps, max * 101n / 100n, 0n, f.addresses[0], { value: parseEther('0.004') + max * 101n / 100n, gasLimit: 15_000_000 })));
    assert.equal(await f.provider.getBalance(f.treasury), treasury, 'a refused launch charges no fee');
  }
  const big = maxFirstBuyGross({ feeBps: 125, vQ: f.virtualQuote }) * 2n;
  await assert.rejects(f.factory.launch.staticCall('Big', 'BIG', 125, big, 0n, f.addresses[0], { value: parseEther('0.004') + big }), /first buy cap/);
});

test('V2 milestone at x5 inside the buy that reaches it; the creator\'s fee and the split continue after it', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { feeBps: 300 });
  await afterWindow(f, l);
  const { saleLiquidity: L, upperTick, lowerTick } = l.launched;
  const sqrtU = sqrtPriceAtTick(upperTick), sqrtL = sqrtPriceAtTick(lowerTick);
  const completeNet = L * Q96 / sqrtL - L * Q96 / sqrtU;
  // About $30,900 of ETH at $2,500 = 12.36 ETH completes the sale.
  relNear(completeNet, parseEther('12.36'), 2_000_000n, 'raise at the milestone');
  const gross = parseEther('14');
  assert.ok(gross - gross * 300n / 10_000n > completeNet, 'this buy crosses x5');
  const r = await swap(f, l, { buy: true, amount: gross });
  const [m] = parse(f.hook, r, 'Milestone');
  assert.ok(m, 'milestone in the same transaction');
  assert.equal((await f.hook.launches(l.token.target)).graduated, true);
  // The pool after x5 is valued at the curve's last price: FDV ~ 5 x $20,000.
  assert.ok((await poolPrice(f, l)).sqrtPrice <= sqrtL, 'price at or past x5');
  assert.equal(await f.hook.currentFeeBps(l.token.target), 300n, 'the chosen fee, not a flat 1%');
  const after = await swap(f, l, { buy: true, amount: parseEther('1') });
  const [fee] = parse(f.hook, after, 'Fee'), [s] = parse(f.hook, after, 'FeeSplit');
  assert.equal(fee.args.feeBps, 300n);
  assert.equal(fee.args.fee, parseEther('0.03'));
  assert.equal(s.args.airdrop, parseEther('0.009'));
  assert.equal(s.args.treasury, parseEther('0.006'));
  const g = await f.hook.ledgers(l.token.target);
  assert.equal(await f.hook.totalOwed(ZeroAddress), ledgerSum(g), 'ledgers stay solvent through the milestone');
});

test('V2 donation before the milestone cannot block it; donated tokens are burned with burn(), so total supply falls', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f);
  await afterWindow(f, l);
  await swap(f, l, { buy: true, amount: parseEther('1') });
  const donor = await f.deploy(uniswapV4Artifact('PoolDonateTest'), f.manager.target);
  await mined(l.token.connect(f.signers[1]).approve(donor.target, 2n ** 255n));
  await mined(donor.connect(f.signers[1]).donate(l.key, 12345n, 10n ** 18n, '0x', { value: 12345n }));
  const supply = await l.token.totalSupply();
  const r = await swap(f, l, { buy: true, amount: parseEther('14') });
  assert.equal(parse(f.hook, r, 'Milestone').length, 1);
  const [b] = parse(f.hook, r, 'Burned');
  assert.ok(b && b.args.amount >= 10n ** 18n - 1n, 'donated tokens burned (fee growth rounds down a wei)');
  assert.equal(await l.token.totalSupply(), supply - b.args.amount);
  assert.equal(b.args.newTotalSupply, supply - b.args.amount);
});

test('V2 USDC pair and fee paid in USDC: same terms in USDC units', async t => {
  const f = await v2Fixture(t);
  const before = await f.usdc.balanceOf(f.treasury);
  const l = await launchV2(f, { usdc: true, inUsdc: true, firstBuy: 100n * 10n ** 6n });
  assert.equal(await f.usdc.balanceOf(f.treasury) - before, 10n * 10n ** 6n, '10 USDC launch fee');
  assert.ok(l.bought > 0n);
  const g = await f.hook.ledgers(l.token.target);
  assert.deepEqual(asSplit(g), splitFee(1_250_000n), '1.25% of 100 USDC, split five ways');
  assert.equal(await f.factory.approvedQuotes(f.usdc.target), USDC_VIRTUAL_QUOTE);
});

test('V2 holders can burn their own tokens; nobody can burn or move anyone else\'s', async t => {
  const f = await v2Fixture(t);
  const l = await launchV2(f, { firstBuy: parseEther('0.1') });
  const held = await l.token.balanceOf(f.addresses[0]), supply = await l.token.totalSupply();
  await mined(l.token.burn(held / 2n));
  assert.equal(await l.token.totalSupply(), supply - held / 2n);
  await assert.rejects(l.token.connect(f.signers[1]).burn(1n), /balance/);
  await assert.rejects(l.token.connect(f.signers[1]).transferFrom(f.addresses[0], f.addresses[1], 1n), /allowance/);
  const tokenWrites = l.token.interface.fragments.filter(x => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability)).map(x => x.name).sort();
  assert.deepEqual(tokenWrites, ['approve', 'burn', 'transfer', 'transferFrom'], 'no mint, pause, owner or tax');
  assert.ok(v4Art('ElpidaV2Token'));
});
