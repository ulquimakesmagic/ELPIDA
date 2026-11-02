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
import './helpers/browser-modules.mjs';
import { graduationSqrtPriceX96, blockedByPool, tokenCheaperInPool, isqrt } from '../apps/web/graduation-unblock.mjs';
import { v3PoolAbi } from '../packages/core/uniswap.mjs';
import { art } from './helpers/dex-fixture.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');
const { PublicRpcSigner } = await import('../apps/web/public-rpc-signer.mjs');

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
  return { f, l, finish, weth, griefer };
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

/** The real wallet object on the local chain, as the site builds it, for one curve. */
async function walletFor(f, l, signer = f.signers[0]) {
  const w = Object.create(TestnetWallet.prototype), address = await signer.getAddress();
  Object.assign(w, {
    address, net: { chainId: 31337, key: 'local', nativeCurrency: { symbol: 'ETH' } }, provider: f.provider, onProgress: m => (w.progress ??= []).push(m),
    signer: new PublicRpcSigner(signer, f.provider, { pollMs: 5 }), config: { contracts: { dexPool: { abi: v3PoolAbi() }, quote: { abi: art('ElpidaToken').abi } }, publicDexes: { local: f.dex.config } },
  });
  Object.defineProperty(w, 'dex', { value: f.dex.config });
  const item = { address: l.token.target, curve: l.curve.target, pair: 'native', symbol: 'HOPE' };
  return { w, item, curve: new Contract(l.curve.target, art('ElpidaDexCurve').abi, w.signer) };
}

test('F-1 fix: the target price the app computes is the price graduation opens the pool at', async t => {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), l = await launch(f);
  await f.advance(61);
  const [vQ, vT, cap, bonus] = await Promise.all([l.curve.virtualQuote(), l.curve.virtualToken(), l.curve.SALE_CAP(), l.curve.liquidityBonus()]);
  const tokenIsToken0 = BigInt(l.token.target) < BigInt(f.dex.weth.target);
  const target = graduationSqrtPriceX96({ virtualQuote: vQ, virtualToken: vT, saleCap: cap, liquidityBonus: bonus, tokenIsToken0 });
  const gross = await l.curve.completionQuote(); await mined(l.curve.buy(gross, 0, { value: gross }));
  const [opened] = await new Contract(await l.curve.pool(), v3PoolAbi(), f.provider).slot0();
  const diff = opened > target ? opened - target : target - opened;
  assert.ok(diff * 1_000_000n <= opened, `within one part per million (opened ${opened}, computed ${target})`);
  assert.ok(blockedByPool({ reason: 'pool price mismatch' }) && !blockedByPool(new Error('slippage')));
  assert.ok(tokenCheaperInPool({ poolSqrtPriceX96: 1n, graduationSqrtPriceX96: 2n, tokenIsToken0: true }) && tokenCheaperInPool({ poolSqrtPriceX96: 3n, graduationSqrtPriceX96: 2n, tokenIsToken0: false }));
  assert.equal(isqrt(10n ** 36n), 10n ** 18n);
});

test('F-1 fix: on a griefed pool the site buys the band (never above the graduation price) and the same action graduates', async t => {
  const { f, l } = await griefedCurve(t, 10_000_000n);
  const { w, item, curve } = await walletFor(f, l);
  const input = await curve.completionQuote();
  const steps = await w.graduationUnblock(item, curve, input, 0n);
  assert.equal(steps.length, 1, 'one pool purchase step for a native curve'); assert.match(steps[0].label, /never above the graduation price/);
  assert.ok(w.progress.some(m => /clears it first/.test(m)));
  const before = await l.token.balanceOf(w.address), ethBefore = await f.provider.getBalance(w.address);
  const r1 = await (await w.signer.sendTransaction({ to: steps[0].to, data: steps[0].data, value: steps[0].value })).wait();
  const bought = (await l.token.balanceOf(w.address)) - before, paid = ethBefore - (await f.provider.getBalance(w.address)) - r1.gasUsed * r1.gasPrice;
  assert.ok(bought >= 9_999_000n * 10n ** 18n, 'the band was bought');
  assert.ok(paid < steps[0].value, 'unused ETH came back in the same transaction (refundETH)');
  const graduationPrice = 9n * await l.curve.virtualQuote() * 10n ** 18n / 10n ** 27n;   // quote-wei per whole token, about
  assert.ok(paid * 10n ** 18n / bought <= graduationPrice * 101n / 100n, 'average price paid is at or below the graduation price');
  await mined(curve.buy(await curve.completionQuote(), 0, { value: await curve.completionQuote() }));
  assert.equal(await l.curve.complete(), true); assert.notEqual(await l.curve.pool(), '0x0000000000000000000000000000000000000000');
});

test('F-1 fix: no extra step when nothing blocks graduation, or when the buy does not complete the curve', async t => {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), l = await launch(f);
  await f.advance(61);
  const { w, item, curve } = await walletFor(f, l);
  assert.deepEqual(await w.graduationUnblock(item, curve, await curve.completionQuote(), 0n), []);
  assert.deepEqual(await w.graduationUnblock(item, curve, 10n ** 15n, 0n), []);
});

/**
 * Review finding E-2, the mirror of F-1: quote (WETH) placed in a pre-created pool just ABOVE the graduation price,
 * more than the adapter's 2% budget can sell into, blocks the completing buy the same way.
 */
async function overpricedCurve(t, bandEth) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), l = await launch(f);
  await f.advance(61);
  const holder = f.signers[2];
  await mined(l.curve.connect(holder).buy(parseEther('0.8'), 0, { value: parseEther('0.8') }));
  const griefer = f.signers[1], weth = f.dex.weth.connect(griefer), token = l.token;
  const manager = new Contract(f.dex.manager.target, v3Artifacts.manager.abi, griefer);
  const tokenFirst = BigInt(token.target) < BigInt(weth.target), [t0, t1] = tokenFirst ? [token.target, weth.target] : [weth.target, token.target];
  const P = 9 * Number(await l.curve.virtualQuote()) / 1e27;
  const p01 = m => tokenFirst ? m * P : 1 / (m * P);
  const tick = p => Math.floor(Math.log(p) / Math.log(1.0001) / 200) * 200;
  const sqrtX96 = p => BigInt(Math.floor(Math.sqrt(p) * 2 ** 48)) * (1n << 48n);
  await mined(manager.createAndInitializePoolIfNecessary(t0, t1, 10000, sqrtX96(p01(1.03))));
  const band = parseEther(bandEth);
  await mined(weth.deposit({ value: band })); await mined(weth.approve(manager.target, band));
  const [lo, hi] = tokenFirst ? [tick(p01(1.004)), tick(p01(1.024))] : [tick(p01(1.024)) + 200, tick(p01(1.004)) + 200];
  await mined(manager.mint({ token0: t0, token1: t1, fee: 10000, tickLower: lo, tickUpper: hi, amount0Desired: tokenFirst ? 0n : band, amount1Desired: tokenFirst ? band : 0n, amount0Min: 0, amount1Min: 0, recipient: f.addresses[1], deadline: BigInt(await f.now() + 600) }));
  return { f, l, holder };
}

test('E-2: quote placed just above the graduation price blocks the completing buy; the curve stays open', async t => {
  const { f, l } = await overpricedCurve(t, '0.3');
  const gross = await l.curve.completionQuote();
  await assert.rejects(mined(l.curve.connect(f.signers[0]).buy(gross, 0, { value: gross, gasLimit: 15_000_000 })), /pool price mismatch|revert/);
  assert.equal(await l.curve.complete(), false);
});

test('E-2 fix: a holder completing the curve first sells into the over-priced pool (never below the graduation price), then graduates', async t => {
  const { f, l, holder } = await overpricedCurve(t, '0.3');
  const { w, item, curve } = await walletFor(f, l, holder);
  const input = await curve.completionQuote();
  const steps = await w.graduationUnblock(item, curve, input, 0n);
  assert.equal(steps.length, 2, 'approve, then sell');
  assert.match(steps[1].label, /never below the graduation price/);
  assert.ok(w.progress.some(m => /priced .* above the curve/.test(m)));
  const held = await l.token.balanceOf(w.address), ethBefore = await f.provider.getBalance(w.address);
  let gas = 0n;
  for (const step of steps) { const r = await (await w.signer.sendTransaction({ to: step.to, data: step.data, value: step.value ?? 0n })).wait(); gas += r.gasUsed * r.gasPrice; }
  const sold = held - await l.token.balanceOf(w.address), received = (await f.provider.getBalance(w.address)) + gas - ethBefore;
  assert.ok(sold > 0n && sold < held, 'only part of the holding was sold; the price limit stopped the rest');
  const graduationPrice = 9n * await l.curve.virtualQuote() * 10n ** 18n / 10n ** 27n;   // quote-wei per whole token, about
  assert.ok(received * 10n ** 18n / sold >= graduationPrice * 99n / 100n, 'sold at about the graduation price or better (net of the 1% pool fee)');
  assert.equal(await f.dex.weth.balanceOf(w.address), 0n, 'paid out as native ETH, not WETH');
  const gross = await curve.completionQuote();
  await mined(curve.buy(gross, 0, { value: gross }));
  assert.equal(await l.curve.complete(), true); assert.notEqual(await l.curve.pool(), '0x0000000000000000000000000000000000000000');
});

test('E-2 fix: a buyer holding no tokens gets the explanation, and nothing is sent', async t => {
  const { f, l } = await overpricedCurve(t, '0.3');
  const { w, item, curve } = await walletFor(f, l, f.signers[3]);
  await assert.rejects(w.graduationUnblock(item, curve, await curve.completionQuote(), 0n), /priced above the curve. Holders can sell/);
});

test('E-3 fix: quote the pool could not take at graduation goes to the fee splitter, not stranded in the curve', async t => {
  // A band too small to block (the adapter's 2% budget sells into it) but large enough to leave WETH over at the mint.
  const { f, l } = await overpricedCurve(t, '0.05');
  const gross = await l.curve.completionQuote();
  const receipt = await mined(l.curve.connect(f.signers[0]).buy(gross, 0, { value: gross }));
  assert.equal(await l.curve.complete(), true);
  const forwarded = receipt.logs.map(log => { try { return l.curve.interface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'QuoteDustForwarded');
  assert.ok(forwarded && forwarded.args.amount > 10n ** 15n, 'a meaningful amount was forwarded');
  assert.equal(forwarded.args.splitter, await l.curve.feeSplitter());
  assert.equal(await l.curve.quoteDust(), 0n, 'nothing left recorded as dust');
  assert.equal(await f.dex.weth.balanceOf(l.curve.target), 0n, 'the curve holds no WETH');
  const splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, f.provider), weth = f.dex.weth.target;
  const owed = (await splitter.claimable(weth, await splitter.treasury())) + (await splitter.claimable(weth, await splitter.creator())) + (await splitter.pendingBuyback(weth));
  assert.equal(owed, forwarded.args.amount, 'the splitter owes exactly what it received, split like LP fees');
  assert.equal(await f.dex.weth.balanceOf(splitter.target), owed);
  await mined(l.curve.forwardQuoteDust());   // a retry with nothing to do is harmless
});
