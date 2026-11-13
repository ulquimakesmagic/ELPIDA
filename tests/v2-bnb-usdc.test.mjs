// BNB Chain's USDC has 18 decimals (Malik, 13 November: "implement the usdc pairs for bnb"). The same V2 launchpad must
// accept it as the USD pricing token and as a trading pair: the $10 launch fee is exactly $10 in its units, the USDC pair
// starts at the same $20,000 and a dollar buys the same tokens as on a 6-decimal USDC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Fixture, launchV2, trade, mined, v4Art } from './helpers/v2-fixture.mjs';
import { ContractFactory } from 'ethers';

const balanceOf = async (f, l) => l.token.balanceOf(f.addresses[1]);

test('18-decimal USDC: configured for USD pricing, the $10 fee in its units, and a 19-decimal or 5-decimal token refused', async t => {
  const f = await v2Fixture(t, { usdcDecimals: 18 });
  assert.equal((await f.factory.feeUsdc()).toLowerCase(), f.usdc.target.toLowerCase());
  const before = await f.usdc.balanceOf(f.treasury);
  await launchV2(f, { inUsdc: true });
  assert.equal(await f.usdc.balanceOf(f.treasury) - before, 10n * 10n ** 18n, 'exactly $10 of an 18-decimal USDC');
  const fresh = await f.deploy(v4Art('ElpidaV2Factory'), f.treasury, 20_000, false);
  for (const d of [19, 5]) {
    const odd = await f.deploy(v4Art('MockUSDC')); await mined(odd.setDecimals(d));
    await assert.rejects(fresh.connect(f.owner).configureUsdPricing.staticCall(f.feed.target, 86400, odd.target), `${d} decimals refused`);
  }
});

test('6-decimal USDC still pays exactly 10,000,000 units (Base, Ethereum)', async t => {
  const f = await v2Fixture(t);
  const before = await f.usdc.balanceOf(f.treasury);
  await launchV2(f, { inUsdc: true });
  assert.equal(await f.usdc.balanceOf(f.treasury) - before, 10_000_000n);
});

test('the USDC pair on 18 decimals: same $20,000 start, a dollar buys the same tokens as on 6 decimals, and sells back', async t => {
  const six = await v2Fixture(t), eighteen = await v2Fixture(t, { usdcDecimals: 18 });
  const [a, b] = [await launchV2(six, { pair: 'usdc', feeBps: 250 }), await launchV2(eighteen, { pair: 'usdc', feeBps: 250 })];
  for (const f of [six, eighteen]) await f.advance(61);
  await trade(six, a, { buy: true, amount: 500n * six.usdcUnit });
  await trade(eighteen, b, { buy: true, amount: 500n * eighteen.usdcUnit });
  const [ta, tb] = [await balanceOf(six, a), await balanceOf(eighteen, b)];
  assert.ok(ta > 0n);
  const diff = ta > tb ? ta - tb : tb - ta;
  // The pool's start price is a whole tick (0.01% steps), so the two start within 0.2% of each other, as the
  // rehearsal's $20,000 check allows (−0.1% / +0.2%).
  assert.ok(diff * 500n <= ta, `$500 buys the same tokens on both, within tick rounding (6: ${ta}, 18: ${tb})`);
  const usdcBefore = await eighteen.usdc.balanceOf(eighteen.addresses[1]);
  await trade(eighteen, b, { buy: false, amount: tb });
  const back = await eighteen.usdc.balanceOf(eighteen.addresses[1]) - usdcBefore;
  // The token's 2.5% fee on the buy and again on the sell: 500 × 0.975 × 0.975 = 475.3125 USDC back.
  assert.ok(back > 475n * eighteen.usdcUnit && back < 476n * eighteen.usdcUnit, `selling returns $500 less both fees (${back})`);
});
