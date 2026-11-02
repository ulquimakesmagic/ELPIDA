// Model 11 launchpad (phase 3, local chain only): Model 10's commercial terms on the v4 hook. Oracle-priced $5,000
// start and $10 fee, USDC pairs (the token is always deployed above the quote, so the quote is currency0), token details
// in the launch transaction, and the fees paid in the pair's quote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits, ZeroAddress } from 'ethers';
import { v4Fixture, launchV4, swap, poolPrice, parse, delta, mined, VIRTUAL_QUOTE, USDC_VIRTUAL_QUOTE, LAUNCH_FEE, TEST_URI, ETH_USD } from './helpers/v4-fixture.mjs';
import { Model10, Q96, sqrtPriceAtTick, fees, split } from './helpers/model10-reference.mjs';

const near = (actual, expected, tolerance, message) => assert.ok((actual > expected ? actual - expected : expected - actual) <= tolerance, `${message}: ${actual} vs ${expected}`);
const VT = 1_111_111_111_111_111n * 10n ** 12n;

async function afterWindow(f, l) {
  const launched = (await f.hook.launches(l.token.target)).launchedAt, now = BigInt(await f.now());
  if (now < launched + 61n) await f.advance(Number(launched + 61n - now));
}

test('oracle pricing: a $5,000 start and a $10 fee in ETH at the feed price; overpayment refunded; stale feed refused', async t => {
  const f = await v4Fixture(t);
  assert.equal(f.virtualQuote, VIRTUAL_QUOTE, '$5,000 x 10/9 at $2,500 per ETH');
  assert.equal(await f.factory.launchFee(), LAUNCH_FEE, '$10 at $2,500 per ETH');
  const treasury = await f.provider.getBalance(f.treasury);
  const creator = await f.provider.getBalance(f.addresses[0]);
  const r = await mined(f.factory.launch('Hope', 'HOPE', 0n, 0n, f.addresses[0], { value: LAUNCH_FEE + parseEther('1') }));
  assert.equal(await f.provider.getBalance(f.treasury) - treasury, LAUNCH_FEE, 'the treasury gets exactly the $10 fee');
  assert.equal(creator - await f.provider.getBalance(f.addresses[0]) - r.gasUsed * r.gasPrice, LAUNCH_FEE, 'the extra 1 ETH came back');
  await assert.rejects(f.factory.launch('Hope', 'HOPE', 0n, 0n, f.addresses[0], { value: LAUNCH_FEE - 1n }));
  // At $5,000 per ETH the same start is half the ETH.
  await mined(f.feed.set(ETH_USD * 2n * 10n ** 8n, await f.now(), 2, 2));
  assert.equal(await f.factory.nativeVirtualQuote(), (parseEther('1') * 10n + 8n) / 9n);
  // A feed older than the allowed age stops launches.
  await f.advance(86_401);
  await assert.rejects(f.factory.launch('Hope', 'HOPE', 0n, 0n, f.addresses[0], { value: LAUNCH_FEE * 2n }));
});

test('testnet terms: a $50 start gives one hundredth of the virtual quote and the same 10x curve', async t => {
  const f = await v4Fixture(t, { startFdvUsd: 50 });
  assert.equal(f.virtualQuote, (parseEther('0.02') * 10n + 8n) / 9n);
  const l = await launchV4(f);
  assert.equal(BigInt(l.launched.upperTick) - BigInt(l.launched.lowerTick), 23_030n);
});

test('USDC pair: the quote is currency0, trades match Model 10 in USDC, the milestone raises about $12,000, fees paid in USDC', async t => {
  const f = await v4Fixture(t);
  const firstBuy = parseUnits('100', 6);
  const l = await launchV4(f, { usdc: true, firstBuy });
  assert.ok(BigInt(l.token.target) > BigInt(f.usdc.target), 'the token is deployed above USDC, so USDC is currency0');
  assert.equal((await f.hook.launches(l.token.target)).quote, f.usdc.target);
  const { saleLiquidity: L, upperTick, lowerTick } = l.launched, sqrtU = sqrtPriceAtTick(upperTick), sqrtL = sqrtPriceAtTick(lowerTick);
  const model = new Model10(L, sqrtU);
  // Launch price: vT / vQ tokens per raw USDC unit, within 0.1% and never cheaper.
  const p0 = VT * Q96 * Q96 / USDC_VIRTUAL_QUOTE, p = sqrtU * sqrtU;
  assert.ok(p <= p0 && (p0 - p) * 1000n <= p0);
  // The creator's first buy in USDC: base fee only.
  const { fee: firstFee } = fees(firstBuy, 125n);
  near(l.bought, model.buyOut(firstBuy - firstFee), model.tokensFor(32n), 'first buy');
  await afterWindow(f, l);
  // A few trades, each checked against Model 10 from the pool's own price.
  let creator = split(fees(firstBuy, 125n).base).creator, protocol = split(fees(firstBuy, 125n).base).protocol;
  for (const [buy, amount] of [[true, parseUnits('250', 6)], [true, parseUnits('1300', 6)], [false, 0n], [true, parseUnits('40', 6)]]) {
    model.sync((await poolPrice(f, l)).sqrtPrice);
    if (buy) {
      const { fee, base } = fees(amount, 125n);
      const d = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: true, amount }));
      assert.equal(d.eth, -amount, 'the buyer pays exactly the gross USDC');
      near(d.token, model.buyOut(amount - fee), model.tokensFor(32n), 'tokens for USDC');
      const s = split(base); creator += s.creator; protocol += s.protocol;
    } else {
      const tokens = (await l.token.balanceOf(f.addresses[1])) / 3n, gross = model.sellGross(tokens), { fee, base } = fees(gross, 125n);
      const d = await delta(f, l, f.addresses[1], () => swap(f, l, { buy: false, amount: tokens }));
      near(d.eth, gross - fee, 32n, 'USDC for tokens');
      const s = split(base); creator += s.creator; protocol += s.protocol;
    }
  }
  // Cross 10x: the sale position held Model 10's raise, about $12,000 at a $5,000 start.
  const r = await swap(f, l, { buy: true, amount: parseUnits('20000', 6) });
  const [m] = parse(f.hook, r, 'Milestone');
  near(m.args.saleQuote, L * Q96 / sqrtL - L * Q96 / sqrtU, 32n, 'raise in USDC');
  assert.ok(m.args.saleQuote > parseUnits('11900', 6) && m.args.saleQuote < parseUnits('12100', 6), `raise ${m.args.saleQuote}`);
  // Fees accrue and are paid in USDC; the hook's USDC claims equal its ledgers.
  const launch = await f.hook.launches(l.token.target);
  assert.equal(await f.manager.balanceOf(f.hook.target, BigInt(f.usdc.target)), await f.hook.totalOwed(f.usdc.target));
  assert.equal(await f.hook.totalOwed(ZeroAddress), 0n, 'no ETH claims for a USDC pair');
  const before = await f.usdc.balanceOf(f.treasury);
  await mined(f.hook.withdrawFees(l.token.target));
  assert.equal(await f.usdc.balanceOf(f.treasury) - before, launch.protocolFees);
  assert.ok(launch.creatorFees > creator, 'the crossing buy added its own creator share');
});

test('fee in USDC: 10 USDC to the treasury and no native fee', async t => {
  const f = await v4Fixture(t);
  const before = await f.usdc.balanceOf(f.treasury), eth = await f.provider.getBalance(f.treasury);
  await launchV4(f, { inUsdc: true, uri: TEST_URI });
  assert.equal(await f.usdc.balanceOf(f.treasury) - before, 10_000_000n);
  assert.equal(await f.provider.getBalance(f.treasury), eth);
});

test('token details: published only in the launch transaction; required where the factory says so', async t => {
  const f = await v4Fixture(t, { requireMetadata: true });
  assert.equal(await f.factory.requiresMetadata(), true);
  await assert.rejects(f.factory.launch('Hope', 'HOPE', 0n, 0n, f.addresses[0], { value: LAUNCH_FEE }), /metadata required/);
  await assert.rejects(f.factory.launchWithPayment('Hope', 'HOPE', ZeroAddress, 0n, 0n, f.addresses[0], 'https://example.com/x.json', false, { value: LAUNCH_FEE }), /IPFS URI required/);
  const l = await launchV4(f, { uri: TEST_URI });
  assert.equal(await f.factory.tokenMetadataURI(l.token.target), TEST_URI);
  assert.equal(parse(f.factory, l.receipt, 'MetadataPublished').length, 1);
});

test('quotes: only team-approved assets, set once by the treasury', async t => {
  const f = await v4Fixture(t);
  await assert.rejects(f.factory.connect(f.signers[1]).approveQuote(f.usdc.target, 1n), /quote approval/);
  await assert.rejects(f.factory.connect(f.signers[2]).approveQuote(f.usdc.target, 1n), /quote approval/, 'already approved; never changed');
  await assert.rejects(f.factory.launchWithPayment('Hope', 'HOPE', f.feed.target, 0n, 0n, f.addresses[0], '', false, { value: LAUNCH_FEE }), /quote not approved/);
});
