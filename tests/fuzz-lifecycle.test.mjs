// Self-audit fuzz campaign (24 Oct 2026): the whole Model 10 lifecycle on the mainnet (atomic) factory, driven by a
// seeded random sequence, on native and USDC pairs. Curve trading by several traders (dust to large), time jumps across
// the anti-snipe minute, an oversized completing buy that graduates in the same transaction, then random swaps on the
// Uniswap v3 pool, fee collection by anyone and claims by both beneficiaries. After every step it checks that every
// token is accounted for, that the curve and the fee splitter hold exactly what they owe, that nothing can be bought
// or sold on a completed curve, and that the liquidity position stays locked. Two seeds run with `npm test`; set
// ELPIDA_LIFECYCLE_SEEDS (comma-separated) for a longer campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ZeroAddress, parseEther, parseUnits } from 'ethers';
import { SALE_CAP, TOKEN_SUPPLY } from '../packages/core/curve-model.mjs';
import { routerAbi } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, mined, quoteBalance, liabilities, art } from './helpers/dex-fixture.mjs';

const SEEDS = [3, 11, ...String(process.env.ELPIDA_LIFECYCLE_SEEDS ?? '').split(',').filter(Boolean).map(Number)];
const DEAD = '0x000000000000000000000000000000000000dEaD';
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const frac = (rand, amount) => amount * BigInt(Math.floor(rand() * 1000) + 1) / 1000n;

async function lifecycle(t, { native, seed, tier = 0 }) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), rand = prng(seed), tag = `seed ${seed} ${native ? 'ETH' : 'USDC'}${tier ? ` tier ${tier}` : ''}`;
  // Early-partner tier (docs/DESIGN_PARTNER_TIERS.md): the launcher is registered, so every curve trade buys back and burns.
  if (tier) await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], tier, BigInt(await f.now()) + 30n * 86400n));
  const traders = [f.signers[0], f.signers[1], f.signers[3]], who = traders.map((_, i) => f.addresses[[0, 1, 3][i]]);
  await mined(f.usdc.mint(f.addresses[3], parseUnits('1000000', 6)));
  const l = await launch(f, { native, firstBuy: rand() < 0.3 ? 1n : native ? frac(rand, parseEther('0.5')) : frac(rand, parseUnits('1000', 6)) });
  const quote = native ? f.dex.weth : f.usdc, token = l.token, curve = l.curve;
  assert.equal(await curve.buybackBps(), BigInt(tier), `${tag}: the launch carries the tier`);
  const tokenAccounts = async extra => (await Promise.all([...who, f.addresses[2], curve.target, DEAD, ...extra].map(a => token.balanceOf(a)))).reduce((a, b) => a + b, 0n);
  const curveChecks = async label => {
    assert.equal(await quoteBalance(f, l), await liabilities(l), `${label}: curve holds exactly what it owes`);
    assert.ok(await curve.sold() <= SALE_CAP, `${label}: within the sale cap`);
    assert.equal(await tokenAccounts([]), TOKEN_SUPPLY, `${label}: every token is accounted for`);
  };
  await curveChecks(`${tag} launch`);

  // 1. Curve trading, short of completion.
  for (let i = 0; i < 20; i++) {
    const label = `${tag} curve step ${i}`, k = Math.floor(rand() * traders.length), s = traders[k];
    if (rand() < 0.3) { await f.advance(Math.floor(rand() * 40)); await f.refreshFeed(); }
    const remaining = await curve.completionQuote();
    if (rand() < 0.6 && remaining > 1n) {
      const gross = rand() < 0.15 ? 1n : frac(rand, remaining / 3n) + 1n;
      if (!native) await mined(f.usdc.connect(s).approve(curve.target, gross));
      await mined(curve.connect(s).buy(gross, 0, { value: native ? gross : 0n }));
    } else {
      const held = await token.balanceOf(who[k]); if (held === 0n) continue;
      const amount = rand() < 0.2 ? held : rand() < 0.1 ? 1n : frac(rand, held);
      await mined(token.connect(s).approve(curve.target, amount));
      // The sell quote refuses a dust sale the same way the sale does.
      const out = await curve.quoteSell(amount).then(([o]) => o, e => { assert.match(String(e.message), /sell dust/, `${label}: only dust is refused`); return 0n; });
      // A sale worth nothing after fees is refused rather than taking the tokens for zero.
      if (out === 0n) { await assert.rejects(curve.connect(s).sell(amount, 0), /sell dust/, `${label}: a worthless sale is refused`); continue; }
      await mined(curve.connect(s).sell(amount, 0));
    }
    await curveChecks(label);
  }

  // 2. An oversized completing buy: fills exactly the rest, refunds the excess and graduates in the same transaction.
  const finisher = pick(rand, traders), needed = await curve.completionQuote(), offered = needed + frac(rand, needed);
  if (!native) await mined(f.usdc.connect(finisher).approve(curve.target, offered));
  await mined(curve.connect(finisher).buy(offered, 0, { value: native ? offered : 0n }));
  const pool = await curve.pool();
  assert.notEqual(pool, ZeroAddress, `${tag}: graduated in the completing buy`);
  assert.equal(await curve.complete(), true); assert.equal(await curve.sold(), SALE_CAP);
  const locker = new Contract(await curve.locker(), art('ElpidaV3FeeLocker').abi, f.signers[0]), positionId = await curve.positionId();
  const splitter = new Contract(await curve.feeSplitter(), art('ElpidaFeeSplitter').abi, f.signers[0]);
  const manager = new Contract(f.dex.manager.target, ['function ownerOf(uint256) view returns(address)'], f.provider);
  const lockedAndOwned = async label => { assert.equal(await locker.locked(), true, label); assert.equal(await manager.ownerOf(positionId), locker.target, `${label}: position still in the locker`); };
  await lockedAndOwned(`${tag} graduation`);
  assert.equal(await quoteBalance(f, l), await liabilities(l), `${tag}: after graduation the curve holds only owed fees`);
  await assert.rejects(curve.connect(finisher).buy(1n, 0, { value: native ? 1n : 0n }), `${tag}: no buys on a completed curve`);
  await assert.rejects(curve.connect(f.signers[0]).sell(1n, 0), `${tag}: no sells on a completed curve`);

  // 3. Random swaps on the pool, fee collection by anyone, claims by both beneficiaries.
  const router = new Contract(f.dex.router.target, routerAbi(2), f.provider), extras = [pool, locker.target, splitter.target];
  const splitterChecks = async label => {
    for (const asset of [token, quote]) {
      const [held, a, b] = await Promise.all([asset.balanceOf(splitter.target), splitter.claimable(asset.target, f.addresses[2]), splitter.claimable(asset.target, await splitter.creator())]);
      assert.equal(held, a + b, `${label}: splitter holds exactly what both can claim`);
    }
    assert.equal(await tokenAccounts(extras), TOKEN_SUPPLY, `${label}: every token is accounted for`);
    await lockedAndOwned(label);
  };
  for (let i = 0; i < 16; i++) {
    const label = `${tag} pool step ${i}`, k = Math.floor(rand() * traders.length), s = traders[k], deadline = (await f.now()) + 600;
    const call = (tokenIn, tokenOut, amountIn, value = 0n) => router.connect(s).multicall(deadline, [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: 10000, recipient: who[k], amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])], { value });
    const action = rand();
    if (action < 0.45) {
      const amountIn = native ? frac(rand, parseEther('0.05')) : frac(rand, parseUnits('100', 6));
      if (!native) await mined(f.usdc.connect(s).approve(router.target, amountIn));
      await mined(call(quote.target, token.target, amountIn, native ? amountIn : 0n));
    } else if (action < 0.85) {
      const held = await token.balanceOf(who[k]); if (held === 0n) continue;
      const amountIn = frac(rand, held); await mined(token.connect(s).approve(router.target, amountIn)); await mined(call(token.target, quote.target, amountIn));
    } else if (action < 0.93) {
      await mined(locker.connect(pick(rand, f.signers)).collectFees());
    } else {
      const recipient = rand() < 0.5 ? f.addresses[2] : await splitter.creator(), asset = rand() < 0.5 ? token : quote;
      const owed = await splitter.claimable(asset.target, recipient), before = await asset.balanceOf(recipient);
      await mined(splitter.connect(pick(rand, f.signers)).claim(asset.target, recipient));
      assert.equal(await asset.balanceOf(recipient) - before, owed, `${label}: a claim pays exactly what was owed`);
      assert.equal(await splitter.claimable(asset.target, recipient), 0n);
    }
    await splitterChecks(label);
  }
  await assert.rejects(splitter.connect(f.signers[1]).claim(token.target, f.addresses[1]), /beneficiary/, `${tag}: only the two fixed beneficiaries`);

  // 4. Everything owed is paid out; the curve and the splitter end empty.
  await mined(locker.collectFees()); await mined(curve.withdrawFees());
  for (const asset of [token, quote]) for (const r of [f.addresses[2], await splitter.creator()]) await mined(splitter.claim(asset.target, r));
  assert.equal(await quoteBalance(f, l), 0n, `${tag}: curve fully paid out`);
  if (tier) { const burned = await curve.buybackBurned(); assert.ok(burned > 0n, `${tag}: trades bought back and burned`); assert.ok(await token.balanceOf(DEAD) >= burned, `${tag}: burned tokens sit at the dead address`); }
  for (const asset of [token, quote]) assert.equal(await asset.balanceOf(splitter.target), 0n, `${tag}: splitter fully paid out`);
}

for (const seed of SEEDS) for (const native of [true, false])
  test(`lifecycle fuzz ${native ? 'ETH' : 'USDC'} seed ${seed}: curve, atomic graduation, pool swaps, fee collection and claims stay exact`, t => lifecycle(t, { native, seed }));
// Elite partner launches (20% of the fee buys back and burns): the default seed runs both pairs; a longer campaign
// (ELPIDA_LIFECYCLE_SEEDS) runs every seed with the tier as well.
for (const seed of [SEEDS[0], ...SEEDS.slice(2)]) for (const native of [true, false])
  test(`lifecycle fuzz ${native ? 'ETH' : 'USDC'} seed ${seed} elite partner: buyback and burn keep every account exact`, t => lifecycle(t, { native, seed, tier: 2000 }));
