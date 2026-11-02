// Model 11 prototype (docs/LOCKED_FROM_LAUNCH_V4_FEASIBILITY.md): Model 10's curve inside one Uniswap v4 pool, with the
// liquidity locked from the first trade. Runs on a local cancun chain against Uniswap's own PoolManager. Nothing here
// is deployed. Every trade is checked against Model 10's formulas in exact rational arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress } from 'ethers';
import { uniswapV4Artifact } from '../scripts/compile-v4.mjs';
import { v4Fixture, launchV4, swap, poolPrice, parse, delta, mined, v4Art, LAUNCH_FEE } from './helpers/v4-fixture.mjs';
import { Model10, Q96, sqrtPriceAtTick, feeBps, fees, split } from './helpers/model10-reference.mjs';

const DEAD = '0x000000000000000000000000000000000000dEaD', SUPPLY = 10n ** 27n, SALE_CAP = 759_746_926_647_958n * 10n ** 12n;
const near = (actual, expected, wei, message) => assert.ok((actual > expected ? actual - expected : expected - actual) <= wei, `${message}: ${actual} vs ${expected}`);
/** Uniswap rounds once per swap step, always for the pool: allow `wei` of ETH, in tokens at the current price. */
const nearEth = (actual, expected, model, message, wei = 32n) => near(actual, expected, model.tokensFor(wei), message);
const sync = async (f, l, model) => model.sync((await poolPrice(f, l)).sqrtPrice);
const relNear = (a, b, ppb, message) => assert.ok((a > b ? a - b : b - a) * 1_000_000_000n <= b * ppb, `${message}: ${a} vs ${b}`);

/** A seeded generator, so the random trade sequence is the same on every run. */
function rng(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

async function setup(t, opts = {}) {
  const f = await v4Fixture(t);
  const l = await launchV4(f, opts);
  const { upperTick, lowerTick, saleLiquidity: L, upperLiquidity: Lp } = l.launched;
  const sqrtU = sqrtPriceAtTick(upperTick), sqrtL = sqrtPriceAtTick(lowerTick);
  return { f, l, L, Lp, sqrtU, sqrtL, model: new Model10(L, sqrtU) };
}

async function afterWindow(f, l) {
  const launched = (await f.hook.launches(l.token.target)).launchedAt;
  const now = BigInt(await f.now());
  if (now < launched + 61n) await f.advance(Number(launched + 61n - now));
}

test('launch: both positions hold the whole supply at the Model 10 price; nobody else can add liquidity or create a pool', async t => {
  const { f, l, L, Lp, sqrtU, sqrtL } = await setup(t);
  const price = await poolPrice(f, l);
  assert.equal(price.sqrtPrice, sqrtU, 'the pool opens at the top of the sale range (the JS TickMath port agrees)');
  assert.equal(price.liquidity, 0n, 'no liquidity is active above the launch price');
  // Launch price: Model 10's vT / vQ, rounded down to the tick spacing.
  const vT = 1_111_111_111_111_111n * 10n ** 12n, p0 = vT * Q96 * Q96 / f.virtualQuote, p = sqrtU * sqrtU;
  assert.ok(p <= p0 && (p0 - p) * 1000n <= p0, 'within 0.1% of Model 10 (never cheaper)');
  // Sale size: Model 10's SALE_CAP to within 0.01% (the range is 10.003x: 23,030 ticks, a multiple of the spacing).
  const sale = L * (sqrtU - sqrtL) / Q96;
  relNear(sale, SALE_CAP, 100_000n, 'sale tokens');
  // L' = L (1 - sqrtL / sqrtU) = 0.6838 L, the liquidity Model 10's graduated pool has.
  relNear(Lp * 10_000n, L * 6838n, 100_000n, 'upper liquidity is 0.6838 L');
  assert.equal(await l.token.balanceOf(f.hook.target), 0n);
  const dust = l.launched.dustBurned;
  assert.ok(dust < 10n ** 6n, `${dust} wei (of 10^27) of rounding dust`);
  assert.equal(await l.token.balanceOf('0x000000000000000000000000000000000000dEaD'), dust);
  assert.equal(await l.token.balanceOf(f.manager.target), SUPPLY - dust, 'the rest is in the pool');
  assert.equal(l.bought, 0n, 'zero creator buy');
  assert.equal(await f.provider.getBalance(f.treasury) > 0n, true);
  // A third-party liquidity add before the milestone is refused, even far from the sale range.
  await assert.rejects(f.liquidityRouter.connect(f.signers[1])['modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)'](l.key, [-887270, 887270, 10n ** 15n, '0x' + '00'.repeat(32)], '0x', { value: parseEther('1') }));
  // Nobody else can create a pool that uses this hook.
  const other = await f.deploy(v4Art('ElpidaToken'), 'X', 'X', SUPPLY, f.addresses[1]);
  await assert.rejects(f.manager.initialize([ZeroAddress, other.target, 0, 10, f.hook.target], sqrtU));
  // And no way to take out principal: besides Uniswap's hook callbacks (the remove-liquidity ones are not enabled and
  // revert), the only state-changing functions are the launch, the payout of fees, the treasury's liquidity switch
  // and the PoolManager callback.
  const writes = f.hook.interface.fragments.filter(x => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability) && !/^(before|after)/.test(x.name)).map(x => x.name).sort();
  assert.deepEqual(writes, ['claimFees', 'launch', 'openLiquidity', 'payoutStep', 'unlockCallback', 'withdrawFees']);
  assert.equal(await f.hook.getHookPermissions().then(p => p.beforeRemoveLiquidity || p.afterRemoveLiquidity), false);
});

test('buys and sells match Model 10 to the wei across a random sequence, with the 1.25% fee split 50/50', async t => {
  const { f, l, model } = await setup(t);
  await afterWindow(f, l);
  const next = rng(42), traders = [1, 3, 4].map(i => f.signers[i]);
  let worst = 0n, creator = 0n, protocol = 0n;
  for (let i = 0; i < 30; i++) {
    const signer = traders[i % 3], who = await signer.getAddress(), held = await l.token.balanceOf(who);
    await sync(f, l, model);
    if (held > 0n && next() < 0.4) {
      const tokens = held * BigInt(Math.floor(next() * 1000) + 1) / 1000n;
      const gross = model.sellGross(tokens), { fee, base } = fees(gross, 125n);
      const d = await delta(f, l, who, () => swap(f, l, { signer, buy: false, amount: tokens }));
      const [ev] = parse(f.hook, d.receipt, 'Fee');
      assert.equal(d.token, -tokens);
      assert.equal(ev.args.fee, fee, 'sell fee: 1.25% of the gross proceeds');
      const diff = d.eth - (gross - fee); worst = diff < 0n ? (-diff > worst ? -diff : worst) : (diff > worst ? diff : worst);
      near(d.eth, gross - fee, 32n, `sell ${i}`);
      assert.ok(d.eth <= gross - fee + 2n, 'never more than Model 10 pays');
      const s = split(base); creator += s.creator; protocol += s.protocol;
    } else {
      const gross = parseEther('0.001') + BigInt(Math.floor(next() * 400)) * parseEther('0.001');
      const { fee, base } = fees(gross, 125n), net = gross - fee, expected = model.buyOut(net);
      const d = await delta(f, l, who, () => swap(f, l, { signer, buy: true, amount: gross }));
      assert.equal(d.eth, -gross, 'the buyer pays exactly the gross amount');
      assert.equal(parse(f.hook, d.receipt, 'Fee')[0].args.fee, fee);
      const diff = (expected - d.token) * parseEther('1') / model.buyOut(parseEther('1')); worst = diff > worst ? diff : worst;
      nearEth(d.token, expected, model, `buy ${i}`);
      assert.ok(d.token <= expected + model.tokensFor(2n), 'never more than Model 10 gives (2 wei: syncing the reference from the price)');
      const s = split(base); creator += s.creator; protocol += s.protocol;
    }
  }
  const launch = await f.hook.launches(l.token.target);
  assert.equal(launch.creatorFees, creator); assert.equal(launch.protocolFees, protocol); assert.equal(launch.liquidityBonus, 0n);
  assert.equal(await f.hook.totalOwed(ZeroAddress), creator + protocol);
  assert.equal(await f.manager.balanceOf(f.hook.target, 0n), creator + protocol, "the hook's ETH claims equal its ledgers");
  t.diagnostic(`largest difference from Model 10 over 30 trades: ${worst} wei of ETH`);
  assert.ok(worst <= 32n);
});

test('anti-snipe: 90% falling to 1.25% over 60 seconds, the surplus kept for the locked liquidity', async t => {
  const { f, l, model } = await setup(t);
  const launchedAt = Number((await f.hook.launches(l.token.target)).launchedAt);
  let bonus = 0n;
  for (const elapsed of [1, 15, 30, 45, 59, 60]) {
    await f.at(launchedAt + elapsed); await sync(f, l, model);
    const gross = parseEther('0.05'), bps = feeBps(elapsed), { fee, base } = fees(gross, bps);
    const d = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: true, amount: gross }));
    const [ev] = parse(f.hook, d.receipt, 'Fee');
    assert.equal(ev.args.feeBps, bps, `fee rate at ${elapsed} s`);
    assert.equal(ev.args.fee, fee); assert.equal(ev.args.lockedBonus, fee - base);
    nearEth(d.token, model.buyOut(gross - fee), model, `tokens at ${elapsed} s`);
    bonus += fee - base;
  }
  assert.equal((await f.hook.launches(l.token.target)).liquidityBonus, bonus);
  assert.equal(await f.hook.currentFeeBps(l.token.target), 125n);
});

test('exact-output swaps pay the same fee as Model 10: on the ETH side, rounded in the pool\'s favour', async t => {
  const { f, l, model } = await setup(t);
  await afterWindow(f, l);
  await swap(f, l, { buy: true, amount: parseEther('1') });
  await sync(f, l, model);
  // Buy exactly 10M tokens.
  const want = 10_000_000n * 10n ** 18n, net = model.buyNetFor(want), fee = (net * 125n + 9874n) / 9875n;
  const d = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: true, amount: want, exactOut: true, value: parseEther('1') }));
  assert.equal(d.token, want);
  near(-d.eth, net + fee, 32n, 'ETH paid for an exact-output buy');
  near(fee, (net + fee) * 125n / 10000n, 1n, 'fee is 1.25% of the gross');
  await sync(f, l, model);
  // Sell for exactly 0.1 ETH.
  const out = parseEther('0.1'), sellFee = (out * 125n + 9874n) / 9875n, tokens = model.sellTokensFor(out + sellFee);
  const s = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: false, amount: out, exactOut: true }));
  assert.equal(s.eth, out);
  nearEth(-s.token, tokens, model, 'tokens sold for an exact-output sell');
  assert.equal(parse(f.hook, s.receipt, 'Fee')[0].args.fee, sellFee);
});

test('the milestone runs inside the buy that reaches 10x: same pool, continuous price, one full-range position', async t => {
  const { f, l, model, L, Lp, sqrtU, sqrtL } = await setup(t);
  await afterWindow(f, l);
  // Model 10: the net ETH that completes the sale, and the tokens it buys.
  const completeNet = L * Q96 / sqrtL - L * Q96 / sqrtU;
  const gross = parseEther('6'), { fee } = fees(gross, 125n), net = gross - fee;
  assert.ok(net > completeNet, 'this buy crosses 10x');
  const saleTokens = L * (sqrtU - sqrtL) / Q96, beyond = net - completeNet;
  // Past 10x the buy continues on L' (constant product from the 10x price).
  const sqrtAfter = (Lp * Q96 * sqrtL) / (Lp * Q96 + beyond * sqrtL), upperTokens = Lp * (sqrtL - sqrtAfter) / Q96;
  const d = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: true, amount: gross }));
  nearEth(d.token, saleTokens + upperTokens, model, 'tokens: the whole sale, then the upper range at a continuous price');
  const [m] = parse(f.hook, d.receipt, 'Milestone');
  near(m.args.saleQuote, completeNet, 32n, "the sale position held Model 10's raise, to the wei of rounding");
  assert.equal(m.args.bonus, 0n);
  const launch = await f.hook.launches(l.token.target);
  assert.equal(launch.graduated, true);
  relNear(launch.milestoneLiquidity, Lp, 1n, 'the new position has the same liquidity as the upper one');
  t.diagnostic(`raise ${(Number(m.args.saleQuote) / 1e18).toFixed(6)} ETH; milestone gas ${d.receipt.gasUsed}`);
  // Below 10x the upper position is active; above it the milestone position. Equal liquidity = one full range.
  const below = await poolPrice(f, l);
  assert.equal(below.liquidity, Lp);
  const held = await l.token.balanceOf(f.addresses[1]);
  await swap(f, l, { buy: false, amount: held / 2n });
  const above = await poolPrice(f, l);
  assert.ok(above.sqrtPrice > sqrtL, 'the sell took the price back below 10x');
  assert.equal(above.liquidity, launch.milestoneLiquidity);
  // After the milestone: the 1% pool fee.
  const after = await swap(f, l, { buy: true, amount: parseEther('0.1') });
  assert.equal(parse(f.hook, after, 'Fee')[0].args.feeBps, 100n);
});

test('third-party liquidity stays refused until the treasury opens a token, only after its milestone, once', async t => {
  const { f, l } = await setup(t);
  await afterWindow(f, l);
  const add = () => f.liquidityRouter.connect(f.signers[1])['modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)'](l.key, [-887270, 887270, 10n ** 15n, '0x' + '00'.repeat(32)], '0x', { value: parseEther('1') });
  await mined(l.token.connect(f.signers[1]).approve(f.liquidityRouter.target, 2n ** 255n));
  await assert.rejects(f.hook.connect(f.signers[2]).openLiquidity(l.token.target), /milestone first/, 'not before the milestone');
  await swap(f, l, { buy: true, amount: parseEther('6') });
  await assert.rejects(add(), 'refused after the milestone too, by default');
  await assert.rejects(f.hook.connect(f.signers[1]).openLiquidity(l.token.target), /owner only/);
  const r = await mined(f.hook.connect(f.signers[2]).openLiquidity(l.token.target));
  assert.equal(parse(f.hook, r, 'LiquidityOpened').length, 1);
  assert.equal((await f.hook.launches(l.token.target)).liquidityOpen, true);
  await mined(add());
  await assert.rejects(f.hook.connect(f.signers[2]).openLiquidity(l.token.target), /already open/, 'once, and never closed');
  // The hook's own positions are unaffected: the pool still charges the hook's 1% and the milestone position stays.
  assert.equal(parse(f.hook, await swap(f, l, { buy: true, amount: parseEther('0.1') }), 'Fee')[0].args.feeBps, 100n);
});

test('a donation before the milestone cannot block it: donated tokens are burned, donated ETH joins the locked liquidity', async t => {
  const { f, l, L, sqrtU, sqrtL } = await setup(t);
  await afterWindow(f, l);
  await swap(f, l, { buy: true, amount: parseEther('1') });
  const donor = await f.deploy(uniswapV4Artifact('PoolDonateTest'), f.manager.target);
  await mined(l.token.connect(f.signers[1]).approve(donor.target, 2n ** 255n));
  await mined(donor.connect(f.signers[1]).donate(l.key, 12345n, 10n ** 18n, '0x', { value: 12345n }));
  const dead = await l.token.balanceOf(DEAD);
  const r = await swap(f, l, { buy: true, amount: parseEther('6') });
  const [m] = parse(f.hook, r, 'Milestone');
  near(m.args.saleQuote, L * Q96 / sqrtL - L * Q96 / sqrtU + 12345n, 32n, 'the raise plus the donated ETH');
  near(await l.token.balanceOf(DEAD) - dead, 10n ** 18n, 1n, 'the donated tokens were burned (fee growth rounds down a wei)');
  assert.equal((await f.hook.launches(l.token.target)).graduated, true);
});

test('sells never take the price above the launch price; selling everything returns the pool to it', async t => {
  const { f, l, sqrtU } = await setup(t);
  await afterWindow(f, l);
  await swap(f, l, { buy: true, amount: parseEther('0.5'), signer: f.signers[1] });
  await swap(f, l, { buy: true, amount: parseEther('0.2'), signer: f.signers[3] });
  // Asking for more ETH than the curve holds would push the price into the empty range above launch.
  await assert.rejects(swap(f, l, { buy: false, amount: parseEther('5'), exactOut: true, signer: f.signers[1] }));
  for (const i of [1, 3]) await swap(f, l, { buy: false, amount: await l.token.balanceOf(f.addresses[i]), signer: f.signers[i] });
  const p = await poolPrice(f, l), left = new Model10(l.launched.saleLiquidity, sqrtU).sync(p.sqrtPrice).R;
  assert.ok(p.sqrtPrice <= sqrtU && left < 100n, `back at the launch price; ${left} wei of rounding left in the curve`);
  const owed = await f.hook.totalOwed(ZeroAddress), pmEth = await f.provider.getBalance(f.manager.target);
  assert.ok(pmEth >= owed && pmEth - owed < 100n, `the PoolManager holds the fee claims plus ${pmEth - owed} wei of rounding`);
});

test('partner tier: 20% of the base fee buys the token in the same swap and sends it to the dead address', async t => {
  const f = await v4Fixture(t);
  await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], 2000, (await f.now()) + 86_400));
  const l = await launchV4(f);
  const { saleLiquidity: L, upperTick } = l.launched, model = new Model10(L, sqrtPriceAtTick(upperTick));
  await afterWindow(f, l);
  let burned = 0n, spent = 0n, protocol = 0n;
  for (const gross of [parseEther('0.3'), parseEther('0.7')]) {
    const { fee, base } = fees(gross, 125n), s = split(base, 2000n);
    await sync(f, l, model);
    const r = await swap(f, l, { buy: true, amount: gross });
    model.R += gross - fee;
    const [b] = parse(f.hook, r, 'BuybackBurned');
    assert.equal(b.args.quoteIn, s.burn, '20% of the base fee, from the protocol half');
    nearEth(b.args.tokensBurned, model.buyOut(s.burn), model, 'bought on the curve at Model 10 prices');
    burned += b.args.tokensBurned; spent += s.burn; protocol += s.protocol;
  }
  const launch = await f.hook.launches(l.token.target);
  assert.equal(launch.buybackBurned, burned); assert.equal(launch.buybackQuoteSpent, spent); assert.equal(launch.protocolFees, protocol);
  assert.equal(await l.token.balanceOf('0x000000000000000000000000000000000000dEaD'), burned + l.launched.dustBurned);
  assert.equal(await f.manager.balanceOf(f.hook.target, 0n), await f.hook.totalOwed(ZeroAddress));
});

test('fee payouts: the treasury and creator are paid in ETH; one that cannot receive never blocks the other', async t => {
  const f = await v4Fixture(t);
  const refuser = f.create2.target; // a contract with no receive function
  const l = await launchV4(f, { reward: refuser });
  await afterWindow(f, l);
  await swap(f, l, { buy: true, amount: parseEther('2') });
  const before = await f.hook.launches(l.token.target), treasuryBefore = await f.provider.getBalance(f.treasury);
  const r = await mined(f.hook.connect(f.signers[3]).withdrawFees(l.token.target));
  assert.equal(await f.provider.getBalance(f.treasury) - treasuryBefore, before.protocolFees);
  assert.equal(parse(f.hook, r, 'FeePayoutFailed')[0].args.amount, before.creatorFees);
  const after = await f.hook.launches(l.token.target);
  assert.equal(after.protocolFees, 0n); assert.equal(after.creatorFees, before.creatorFees, 'kept for a later claim');
  assert.equal(await f.manager.balanceOf(f.hook.target, 0n), after.creatorFees);
  await assert.rejects(f.hook.claimFees(l.token.target, f.addresses[1]), /fee recipient/);
});

test('creator first buy: base fee only, even inside the anti-snipe window; a large one reaches the milestone at launch', async t => {
  const f = await v4Fixture(t);
  const gross = parseEther('0.5'), { fee } = fees(gross, 125n);
  const l = await launchV4(f, { firstBuy: gross });
  const model = new Model10(l.launched.saleLiquidity, sqrtPriceAtTick(l.launched.upperTick));
  nearEth(l.bought, model.buyOut(gross - fee), model, 'first buy at Model 10 prices');
  assert.equal(await l.token.balanceOf(f.addresses[0]), l.bought);
  assert.equal(parse(f.hook, l.receipt, 'Fee')[0].args.feeBps, 125n);
  const big = await launchV4(f, { firstBuy: parseEther('6'), symbol: 'BIG' });
  assert.equal((await f.hook.launches(big.token.target)).graduated, true);
  await assert.rejects(launchV4(f, { firstBuy: parseEther('0.1'), minOut: 10n ** 30n, symbol: 'MIN' }), 'slippage');
});

test('gas', async t => {
  const f = await v4Fixture(t);
  const l = await launchV4(f), gas = { launch: l.receipt.gasUsed };
  await afterWindow(f, l);
  gas.buySmall = (await swap(f, l, { buy: true, amount: parseEther('0.01') })).gasUsed;
  gas.buyOneEth = (await swap(f, l, { buy: true, amount: parseEther('1') })).gasUsed;
  gas.sell = (await swap(f, l, { buy: false, amount: (await l.token.balanceOf(f.addresses[1])) / 10n })).gasUsed;
  gas.milestoneBuy = (await swap(f, l, { buy: true, amount: parseEther('5') })).gasUsed;
  gas.afterMilestone = (await swap(f, l, { buy: true, amount: parseEther('0.01') })).gasUsed;
  t.diagnostic(Object.entries(gas).map(([k, v]) => `${k} ${v}`).join(', '));
  assert.ok(gas.buySmall < 300_000n && gas.milestoneBuy < 600_000n && gas.launch < 1_000_000n);
  assert.equal(LAUNCH_FEE > 0n, true);
});

test('invariant across a mixed sequence through the milestone: the hook\'s ETH claims always equal its ledgers', async t => {
  const f = await v4Fixture(t);
  await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], 1000, (await f.now()) + 86_400));
  const l = await launchV4(f, { firstBuy: parseEther('0.05') });
  const next = rng(7), launchedAt = Number((await f.hook.launches(l.token.target)).launchedAt);
  let crossed = false;
  for (let i = 0; i < 40; i++) {
    if (i < 6) await f.at(launchedAt + 1 + i * 10); // part of the sequence inside the anti-snipe window
    const signer = f.signers[1 + (i % 3)], who = await signer.getAddress(), held = await l.token.balanceOf(who);
    const kind = next();
    if (i === 30 && !crossed) await swap(f, l, { signer, buy: true, amount: parseEther('6') }); // then ten steps after it
    else if (held > 0n && kind < 0.3) await swap(f, l, { signer, buy: false, amount: held * BigInt(1 + Math.floor(next() * 900)) / 1000n });
    else if (held > 10n ** 18n && kind < 0.4) await swap(f, l, { signer, buy: false, amount: parseEther('0.0001'), exactOut: true });
    else if (kind < 0.5) await swap(f, l, { signer, buy: true, amount: 10n ** 21n, exactOut: true, value: parseEther('0.1') });
    else await swap(f, l, { signer, buy: true, amount: parseEther('0.1') + BigInt(Math.floor(next() * 1200)) * parseEther('0.001') });
    const launch = await f.hook.launches(l.token.target), owed = await f.hook.totalOwed(ZeroAddress);
    assert.equal(await f.manager.balanceOf(f.hook.target, 0n), owed, `step ${i}: claims equal the ledgers`);
    assert.equal(owed, launch.creatorFees + launch.protocolFees + launch.liquidityBonus, `step ${i}: one launch, so the ledgers add up`);
    if (launch.graduated) { assert.equal(launch.liquidityBonus, 0n); crossed = true; }
  }
  assert.ok(crossed, 'the sequence reached the milestone');
  assert.ok((await f.hook.launches(l.token.target)).buybackBurned > 0n);
});
