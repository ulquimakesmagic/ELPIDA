// Audit finding F-1 (docs/AUDIT_SCOPE.md). Anyone can create the Uniswap pool for a token before it graduates.
// A thin pool at a wrong price is corrected during graduation (chain-lifecycle check 11), and so is deep full-range
// liquidity at a wrong price. But a narrow band of the token's own supply placed just below the graduation price
// absorbs the adapter's 2% correction budget, so the completing buy reverts ("pool price mismatch") and the curve
// keeps trading. Nothing is lost, and anyone can clear it by buying the band on the pool (at or below the curve's
// price), after which completion graduates normally. This test pins that behaviour until the design decision is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, Interface, parseEther } from 'ethers';
import { dexFixture, launch, mined } from './helpers/dex-fixture.mjs';
import { v3Artifacts } from '../packages/core/uniswap.mjs';
import { swapCalldata } from '../packages/core/dex-router.mjs';

async function griefedCurve(t, bandTokens) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), l = await launch(f);
  await f.advance(61);
  const griefer = f.signers[1];
  await mined(l.curve.connect(griefer).buy(parseEther('0.5'), 0, { value: parseEther('0.5') }));
  const token = l.token.connect(griefer), amount = bandTokens * 10n ** 18n, weth = f.dex.weth.target;
  const manager = new Contract(f.dex.manager.target, v3Artifacts.manager.abi, griefer);
  const tokenFirst = BigInt(token.target) < BigInt(weth), [t0, t1] = tokenFirst ? [token.target, weth] : [weth, token.target];
  const graduationPrice = 9 * Number(await l.curve.virtualQuote()) / 1e27;   // quote-wei per token-wei at SALE_CAP
  const tickOf = p => Math.floor(Math.log(p) / Math.log(1.0001) / 200) * 200, Q96 = 1n << 96n;
  await mined(manager.createAndInitializePoolIfNecessary(t0, t1, 10000, tokenFirst ? Q96 / 1_000_000n : Q96 * 1_000_000n)); // far too cheap
  const [lo, hi] = tokenFirst ? [tickOf(0.80 * graduationPrice), tickOf(0.97 * graduationPrice)] : [tickOf(1 / (0.97 * graduationPrice)), tickOf(1 / (0.80 * graduationPrice))];
  await mined(token.approve(manager.target, amount));
  await mined(manager.mint({ token0: t0, token1: t1, fee: 10000, tickLower: lo, tickUpper: hi, amount0Desired: tokenFirst ? amount : 0n, amount1Desired: tokenFirst ? 0n : amount, amount0Min: 0, amount1Min: 0, recipient: f.addresses[1], deadline: BigInt(await f.now() + 600) }));
  const finish = async () => { const gross = await l.curve.completionQuote(); return mined(l.curve.connect(f.signers[0]).buy(gross, 0, { value: gross })); };
  return { f, l, finish, weth };
}

test('F-1: a 2M-token band is absorbed by the correction budget; graduation proceeds', async t => {
  const { l, finish } = await griefedCurve(t, 2_000_000n);
  await finish(); assert.equal(await l.curve.complete(), true); assert.notEqual(await l.curve.pool(), '0x0000000000000000000000000000000000000000');
});

test('F-1: a 10M-token band (1.3% of the sale) blocks the completing buy; the curve stays open; buying the band out unblocks it', async t => {
  const { f, l, finish, weth } = await griefedCurve(t, 10_000_000n);
  await assert.rejects(finish(), /pool price mismatch/);
  assert.equal(await l.curve.complete(), false, 'the buy reverted in full; the curve is still trading');
  const router = f.dex.router.target, deadline = BigInt(await f.now() + 600), arb = f.signers[3], spend = parseEther('2');
  await mined(arb.sendTransaction({ to: router, value: spend, data: swapCalldata(Interface, 2, router, { tokenIn: weth, tokenOut: l.token.target, fee: 10000, recipient: f.addresses[3], amountIn: spend, amountOutMinimum: 0n }, { deadline }) }));
  assert.ok(await l.token.balanceOf(f.addresses[3]) >= 9_999_000n * 10n ** 18n, 'the band was bought out');
  await finish(); assert.equal(await l.curve.complete(), true, 'graduation now succeeds');
});
