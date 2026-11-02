// Review finding E-1: before the fix, a front-run buy followed by several buyback() calls and a back-run sell took
// about 32% of a partner token's queued buyback (0.061 WETH of 0.19 in the reviewer's proof of concept). The splitter
// now spends at most 0.5% of the pool per call, once per block, and only while the price is within 150 ticks of its
// 10-minute average. This replays the attack and checks it no longer pays, whether the front-run is large (the
// buyback refuses) or small enough to stay inside the band (the buyback runs, and the attacker still loses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, parseEther } from 'ethers';
import { routerAbi } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';

async function queued(t) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' });
  await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], 2000, BigInt(await f.now()) + 30n * 86400n));
  const l = await launch(f, { native: true, firstBuy: parseEther('0.02') });
  await complete(f, l, { signer: f.signers[1] });
  const locker = new Contract(await l.curve.locker(), art('ElpidaV3FeeLocker').abi, f.signers[0]);
  const splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, f.signers[0]);
  const router = new Contract(f.dex.router.target, routerAbi(2), f.provider), weth = f.dex.weth, token = l.token;
  const swap = async (signer, tokenIn, tokenOut, amountIn, value = 0n) => {
    const deadline = (await f.now()) + 600, to = await signer.getAddress();
    await mined(router.connect(signer).multicall(deadline, [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: 10000, recipient: to, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])], { value }));
  };
  for (let i = 0; i < 12; i++) {
    await swap(f.signers[3], weth.target, token.target, parseEther('8'), parseEther('8'));
    const bag = await token.balanceOf(f.addresses[3]);
    await mined(token.connect(f.signers[3]).approve(f.dex.router.target, bag));
    await swap(f.signers[3], token.target, weth.target, bag);
  }
  await mined(locker.collectFees());
  await f.advance(601);
  return { f, splitter, weth, token, swap };
}

for (const [front, calls] of [['2', 10], ['0.01', 10]]) test(`E-1: a ${front} ETH front-run around up to ${calls} buybacks does not profit`, async t => {
  const { f, splitter, weth, token, swap } = await queued(t);
  const atk = f.signers[1], A = parseEther(front), pending = await splitter.pendingBuyback(weth.target);
  assert.ok(pending > 0n);
  await mined(weth.connect(atk).deposit({ value: A })); await mined(weth.connect(atk).approve(f.dex.router.target, A));
  const tokensBefore = await token.balanceOf(f.addresses[1]), wethBefore = await weth.balanceOf(f.addresses[1]);
  await swap(atk, weth.target, token.target, A);
  let ran = 0;
  for (let i = 0; i < calls; i++) {
    try { await mined(splitter.connect(atk).buyback()); ran++; }
    catch (error) { assert.match(String(error.message), /price away from average/); break; }
  }
  const bag = (await token.balanceOf(f.addresses[1])) - tokensBefore;
  await mined(token.connect(atk).approve(f.dex.router.target, bag));
  await swap(atk, token.target, weth.target, bag);
  const profit = (await weth.balanceOf(f.addresses[1])) - wethBefore;
  assert.ok(profit < 0n, `the attacker lost ${-profit} wei`);
  assert.ok(ran <= 1, 'at most one buyback ran inside the attack');
  if (front === '2') assert.equal(ran, 0, 'a large front-run makes the buyback refuse');
});
