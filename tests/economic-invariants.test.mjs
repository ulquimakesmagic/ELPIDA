// Mainnet checklist C2: economic invariant tests for the Model 10 curve. A seeded random driver runs many traders,
// random buy and sell sizes and random time jumps (inside and after the anti-snipe minute) on native and USDC curves,
// and checks after EVERY trade that the curve stays exactly backed, conserves tokens, charges and splits fees exactly,
// moves the price the right way, and never pays a round trip a profit. It ends with a bank run: every holder sells
// everything in random order. Seeds are fixed so a failure is reproducible; set ELPIDA_FUZZ_SEEDS to add more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';
import { SALE_CAP, TOKEN_SUPPLY } from '../packages/core/curve-model.mjs';
import { dexFixture, launch, mined, quoteBalance, liabilities, parse } from './helpers/dex-fixture.mjs';

const BASE_BPS = 125n, SNIPE_WINDOW = 60;
const SEEDS = [1, 7, 42, ...String(process.env.ELPIDA_FUZZ_SEEDS ?? '').split(',').filter(Boolean).map(Number)];
const STEPS = 28;
const DEAD = '0x000000000000000000000000000000000000dEaD';

function prng(seed) { // mulberry32: small, deterministic, good enough to pick sizes and orders
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function snapshot(f, l, holders) {
  const c = l.curve;
  const [vq, vt, sold, reserve, protocol, creator, bonus, curveTokens, quoteHeld, complete, burned, burnSpent, dead, tier] = await Promise.all([
    c.virtualQuote(), c.virtualToken(), c.sold(), c.realReserve(), c.protocolFees(), c.creatorFees(), c.liquidityBonus(),
    l.token.balanceOf(c.target), quoteBalance(f, l), c.complete(), c.buybackBurned(), c.buybackQuoteSpent(), l.token.balanceOf(DEAD), c.buybackBps(),
  ]);
  const held = await Promise.all(holders.map(h => l.token.balanceOf(h)));
  return { vq, vt, sold, reserve, protocol, creator, bonus, curveTokens, quoteHeld, complete, burned, burnSpent, dead, tier, held, priceNum: vq + reserve, priceDen: vt - sold };
}

/** Invariants that must hold in every state. */
async function checkState(f, l, holders, label) {
  const s = await snapshot(f, l, holders);
  assert.equal(s.quoteHeld, await liabilities(l), `${label}: curve holds exactly reserve + owed fees + locked bonus`);
  assert.ok(s.sold <= SALE_CAP, `${label}: sold within the sale cap`);
  assert.equal(s.curveTokens, TOKEN_SUPPLY - s.sold, `${label}: curve holds the unsold supply`);
  // Partner tiers buy back and burn: sold tokens are what holders have plus what was burned at the dead address.
  assert.equal(s.held.reduce((a, b) => a + b, 0n) + s.burned, s.sold, `${label}: sold tokens are exactly what holders have, plus burned`);
  assert.equal(s.dead, s.burned, `${label}: every burned token is at the dead address`);
  if (s.tier === 0n) assert.equal(s.burned, 0n, `${label}: a standard token never burns`);
  assert.ok(s.creator >= s.protocol, `${label}: creator share rounds up, protocol share rounds down`);
  return s;
}

const priceUp = (a, b) => b.priceNum * a.priceDen > a.priceNum * b.priceDen;   // b strictly above a
const priceDown = (a, b) => b.priceNum * a.priceDen < a.priceNum * b.priceDen;

/** Checks the fee accounting of one trade from the state before and after it. */
function checkTradeFees(before, after, gross, feeBps, label) {
  const base = gross * BASE_BPS / 10000n, total = gross * feeBps / 10000n, burn = base * before.tier / 10000n;
  const dProtocol = after.protocol - before.protocol, dCreator = after.creator - before.creator, dBonus = after.bonus - before.bonus;
  const dSpent = after.burnSpent - before.burnSpent;
  assert.equal(dCreator, base - base / 2n, `${label}: creator gets half the base fee (the 1 wei remainder too), whatever the tier`);
  assert.equal(dProtocol, base / 2n - burn, `${label}: protocol gets floor(base / 2) minus the burn share`);
  // The burn share either bought and burned tokens, or (if that would have reached the cap or bought nothing) was locked.
  assert.ok(dSpent === burn || dSpent === 0n, `${label}: the buyback spends the whole burn share or none of it`);
  assert.equal(dBonus, total - base + (burn - dSpent), `${label}: anything above 1.25%, plus a skipped buyback, is locked as liquidity bonus`);
}

async function feeBpsAtNextBlock(f, l) {
  // The fee is evaluated in the block that mines the trade; pin that block's timestamp so the expectation is exact.
  const next = (await f.now()) + 1; await f.at(next);
  const launched = Number(await l.curve.launchedAt()), elapsed = next - launched;
  return elapsed >= SNIPE_WINDOW ? BASE_BPS : BASE_BPS + (9000n - BASE_BPS) * BigInt(SNIPE_WINDOW - elapsed) / BigInt(SNIPE_WINDOW);
}

async function buy(f, l, signer, gross, holders, label) {
  if (!l.native) await mined(f.usdc.connect(signer).approve(l.curve.target, gross));
  const before = await snapshot(f, l, holders), fee2 = await feeBpsAtNextBlock(f, l);
  const receipt = await mined(l.curve.connect(signer).buy(gross, 0, { value: l.native ? gross : 0n }));
  const [ev] = parse(l.curve, receipt, 'Bought');
  const after = await checkState(f, l, holders, label);
  const spent = ev.args[2];
  assert.ok(spent <= gross, `${label}: never spends more than offered`);
  assert.equal(after.quoteHeld - before.quoteHeld, spent, `${label}: curve receives exactly what was spent (rest refunded)`);
  checkTradeFees(before, after, spent, fee2, label);
  assert.ok(priceUp(before, after), `${label}: a buy raises the price`);
  return { out: ev.args[3], spent, after };
}

async function sell(f, l, signer, amount, holders, label) {
  await mined(l.token.connect(signer).approve(l.curve.target, amount));
  const before = await snapshot(f, l, holders), feeBps = await feeBpsAtNextBlock(f, l);
  const receipt = await mined(l.curve.connect(signer).sell(amount, 0));
  const [ev] = parse(l.curve, receipt, 'Sold');
  const after = await checkState(f, l, holders, label);
  // The sale's gross left the reserve; any buyback from its fee paid back into it.
  const out = ev.args[2], gross = before.reserve - after.reserve + (after.burnSpent - before.burnSpent);
  assert.equal(before.quoteHeld - after.quoteHeld, out, `${label}: seller receives exactly the quoted output`);
  checkTradeFees(before, after, gross, feeBps, label);
  assert.ok(priceDown(before, after), `${label}: a sell lowers the price`);
  return { out, after };
}

async function fuzz(t, { native, seed, tier = 0 }) {
  const f = await dexFixture(t), rand = prng(seed), traders = [f.signers[0], f.signers[1], f.signers[3]];
  if (tier) await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], tier, BigInt(await f.now()) + 30n * 86400n));
  await mined(f.usdc.mint(f.addresses[3], parseUnits('1000000', 6)));
  const l = await launch(f, { native, firstBuy: native ? parseEther('0.05') : parseUnits('100', 6) });
  const holders = f.addresses.slice(0, 4); // creator (0), traders (1, 3); 2 is the treasury and never trades
  await checkState(f, l, holders, 'after launch');
  const unit = native ? parseEther('0.001') : parseUnits('2.5', 6), maxUnits = 400; // up to 0.4 ETH or $1,000 per buy
  let trades = 0;
  for (let i = 0; i < STEPS; i++) {
    if (rand() < 0.35) await f.advance(Math.floor(rand() * 25)); // drift across the anti-snipe minute
    const who = traders[Math.floor(rand() * traders.length)], addr = await who.getAddress();
    const label = `seed ${seed} ${native ? 'ETH' : 'USDC'} step ${i}`;
    const balance = await l.token.balanceOf(addr), r = rand();
    if (r < 0.15) { // round trip: buy then sell everything just bought, same trader
      const gross = unit * BigInt(1 + Math.floor(rand() * maxUnits));
      const b = await buy(f, l, who, gross, holders, label + ' round-trip buy');
      if (b.after.complete) break;
      const s = await sell(f, l, who, b.out, holders, label + ' round-trip sell');
      assert.ok(s.out < b.spent, `${label}: a round trip never returns more than was spent`);
      trades += 2;
    } else if (r < 0.6 || balance === 0n) {
      const gross = unit * BigInt(1 + Math.floor(rand() * maxUnits));
      const b = await buy(f, l, who, gross, holders, label + ' buy'); trades++;
      if (b.after.complete) break;
    } else {
      const amount = balance * BigInt(1 + Math.floor(rand() * 100)) / 100n;
      if (amount > 0n) { await sell(f, l, who, amount, holders, label + ' sell'); trades++; }
    }
  }
  return { f, l, holders, traders, rand, trades };
}

// Standard tokens on every seed; early-partner tokens (10% and 20% of the fee buy back and burn) on the first two seeds,
// and on every extra seed of a longer campaign (ELPIDA_FUZZ_SEEDS).
const CASES = [...SEEDS.map(seed => ({ seed, tier: 0 })), { seed: SEEDS[0], tier: 1000 }, { seed: SEEDS[1], tier: 2000 },
  ...SEEDS.slice(3).flatMap(seed => [{ seed, tier: 1000 }, { seed, tier: 2000 }])];
for (const native of [true, false]) {
  for (const { seed, tier } of CASES) {
    test(`invariants hold through a random trading sequence and a full bank run (${native ? 'ETH' : 'USDC'}, seed ${seed}${tier ? `, partner tier ${tier}` : ''})`, async t => {
      const { f, l, holders, rand, trades } = await fuzz(t, { native, seed, tier });
      assert.ok(trades > 10, 'the sequence actually traded');
      const bonus = await l.curve.liquidityBonus(), sold = await l.curve.sold(), done = await l.curve.complete();
      t.diagnostic(`trades=${trades} sold=${sold * 10000n / SALE_CAP / 100n}% of cap, anti-snipe bonus=${bonus}, complete=${done}`);
      if (done) return; // a completed curve is covered by the completion test below
      // Bank run: every holder (creator included) sells everything, in a random order, after the anti-snipe minute.
      await f.advance(SNIPE_WINDOW + 1);
      const sellers = [f.signers[0], f.signers[1], f.signers[3]].sort(() => rand() - 0.5);
      for (const s of sellers) {
        const balance = await l.token.balanceOf(await s.getAddress());
        if (balance > 0n) await sell(f, l, s, balance, holders, `seed ${seed} bank run`);
      }
      const end = await checkState(f, l, holders, 'after bank run');
      assert.equal(end.sold, end.burned, 'everything was sold back except what was burned');
      assert.ok(end.reserve >= 0n, 'reserve never goes negative');
      // What is left is rounding that favours the curve, plus fees owed and the locked bonus; all of it is backed.
      assert.equal(end.quoteHeld, end.reserve + end.protocol + end.creator + end.bonus);
      await mined(l.curve.withdrawFees());
      const after = await checkState(f, l, holders, 'after fee withdrawal');
      assert.equal(after.protocol + after.creator, 0n, 'both fee ledgers paid out');
    });
  }
}

for (const native of [true, false]) {
  test(`an oversized final buy completes the curve exactly and pays only what it used (${native ? 'ETH' : 'USDC'})`, async t => {
    const f = await dexFixture(t), l = await launch(f, { native });
    const holders = f.addresses.slice(0, 4), buyer = f.signers[1], addr = f.addresses[1];
    await f.advance(SNIPE_WINDOW + 1);
    const needed = await l.curve.completionQuote(), gross = needed * 3n;
    const quoteBefore = native ? await f.provider.getBalance(addr) : await f.usdc.balanceOf(addr);
    if (!native) await mined(f.usdc.connect(buyer).approve(l.curve.target, gross));
    const receipt = await mined(l.curve.connect(buyer).buy(gross, 0, { value: native ? gross : 0n }));
    const [ev] = parse(l.curve, receipt, 'Bought'), spent = ev.args[2];
    const s = await checkState(f, l, holders, 'completed');
    assert.equal(s.sold, SALE_CAP); assert.equal(s.complete, true);
    assert.ok(spent <= needed, 'never charged more than the completion quote');
    const quoteAfter = native ? await f.provider.getBalance(addr) : await f.usdc.balanceOf(addr);
    const gas = native ? receipt.gasUsed * receipt.gasPrice : 0n;
    assert.equal(quoteBefore - quoteAfter, spent + gas, 'buyer paid exactly the amount used; the rest came back');
    await assert.rejects(l.curve.connect(buyer).buy(1n, 0, { value: native ? 1n : 0n }), /complete/);
  });
}
