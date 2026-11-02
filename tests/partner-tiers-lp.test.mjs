// Early-partner tiers after graduation (docs/DESIGN_PARTNER_TIERS.md 2.3): the LP fee splitter gives the creator 50%,
// burns the tier's share of token-side fees at deposit, and queues the quote-side share for `buyback()`, which swaps
// at most 0.5% of the pool's quote balance per call through the pool and sends the tokens to the dead address. Only the
// pool may call the swap callback, and only during the splitter's own buyback. A buyback runs at most once per block
// and only while the pool price is within 150 ticks of its 10-minute average (review finding E-1: sandwiching).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ZeroAddress, parseEther } from 'ethers';
import { routerAbi } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';

const DEAD = '0x000000000000000000000000000000000000dEaD';

async function graduated(t, tier) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' });
  if (tier) await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], tier, BigInt(await f.now()) + 30n * 86400n));
  const l = await launch(f, { native: true, firstBuy: parseEther('0.02') });
  await complete(f, l, { signer: f.signers[1] });
  const pool = await l.curve.pool();
  assert.notEqual(pool, ZeroAddress, 'graduated');
  const locker = new Contract(await l.curve.locker(), art('ElpidaV3FeeLocker').abi, f.signers[0]);
  const splitter = new Contract(await l.curve.feeSplitter(), art('ElpidaFeeSplitter').abi, f.signers[0]);
  const router = new Contract(f.dex.router.target, routerAbi(2), f.provider);
  const weth = f.dex.weth, token = l.token;
  const swap = async (signer, tokenIn, tokenOut, amountIn, value = 0n) => {
    const deadline = (await f.now()) + 600, to = await signer.getAddress();
    await mined(router.connect(signer).multicall(deadline, [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: 10000, recipient: to, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])], { value }));
  };
  return { f, l, pool, locker, splitter, weth, token, swap };
}

test('partner pool fees: creator keeps 50%, token side burns at deposit, quote side queues, buyback burns within 0.5% of depth', async t => {
  const { f, pool, locker, splitter, weth, token, swap } = await graduated(t, 2000);
  assert.equal(await splitter.buybackBps(), 2000n);
  assert.equal((await splitter.pool()).toLowerCase(), pool.toLowerCase());
  // Trade both ways on the pool to earn fees in both assets.
  await swap(f.signers[3], weth.target, token.target, parseEther('0.3'), parseEther('0.3'));
  const held = await token.balanceOf(f.addresses[1]);
  await mined(token.connect(f.signers[1]).approve(f.dex.router.target, held / 3n));
  await swap(f.signers[1], token.target, weth.target, held / 3n);

  // Graduation already paid its quote dust into the splitter (review finding E-3), so compare against what was queued before.
  const deadBefore = await token.balanceOf(DEAD), burnedBefore = await splitter.burned(), queuedBefore = await splitter.pendingBuyback(weth.target);
  const receipt = await mined(locker.collectFees());
  const funded = receipt.logs.map(log => { try { return splitter.interface.parseLog(log); } catch { return null; } }).filter(e => e?.name === 'FeesFunded');
  assert.equal(funded.length, 2, 'fees in both assets');
  for (const e of funded) {
    const [asset, amount, protocol, creatorShare] = e.args, burn = amount * 2000n / 10000n;
    assert.equal(creatorShare, amount - amount / 2n, 'creator keeps half, with the remainder');
    assert.equal(protocol, amount - creatorShare - burn, 'the burn comes out of the protocol half');
    if (asset.toLowerCase() === token.target.toLowerCase()) {
      assert.equal(await splitter.burned() - burnedBefore, burn, 'token-side share burned at deposit');
      assert.equal(await token.balanceOf(DEAD) - deadBefore, burn);
    } else assert.equal(await splitter.pendingBuyback(asset) - queuedBefore, burn, 'quote-side share queued');
  }
  const ledger = async asset => (await splitter.claimable(asset, f.addresses[2])) + (await splitter.claimable(asset, await splitter.creator())) + (await splitter.pendingBuyback(asset));
  assert.equal(await weth.balanceOf(splitter.target), await ledger(weth.target), 'splitter WETH = claims + pending buyback');

  // An outsider cannot fake the swap callback to drain the queue.
  await assert.rejects(splitter.connect(f.signers[3]).uniswapV3SwapCallback(1n, 0n, '0x'), /callback/);

  // Right after graduation the pool has no price history yet; once the price has settled for a while it does.
  await assert.rejects(splitter.buyback(), /price history too short/);
  await f.advance(601);
  const pending = await splitter.pendingBuyback(weth.target), depth = await weth.balanceOf(pool);
  const cap = depth * 50n / 10000n, deadMid = await token.balanceOf(DEAD);
  await mined(splitter.connect(f.signers[3]).buyback());
  const spent = pending - await splitter.pendingBuyback(weth.target);
  assert.equal(spent, pending < cap ? pending : cap, 'spends the queue, capped at 0.5% of the pool quote balance');
  assert.ok(await token.balanceOf(DEAD) > deadMid, 'bought tokens went to the dead address');
  assert.equal(await weth.balanceOf(splitter.target), await ledger(weth.target), 'still exactly backed');
  if (pending <= cap) await assert.rejects(splitter.buyback(), /nothing to buy back/);
});

test('a large queue is bought back over several calls, each within 0.5% of the pool', async t => {
  const { f, pool, locker, splitter, weth, token, swap } = await graduated(t, 2000);
  // Heavy two-way trading builds a quote-side queue larger than 1% of the pool.
  for (let i = 0; i < 12; i++) {
    await swap(f.signers[3], weth.target, token.target, parseEther('8'), parseEther('8'));
    const bag = await token.balanceOf(f.addresses[3]);
    await mined(token.connect(f.signers[3]).approve(f.dex.router.target, bag));
    await swap(f.signers[3], token.target, weth.target, bag);
  }
  await mined(locker.collectFees());
  let calls = 0;
  while ((await splitter.pendingBuyback(weth.target)) > 0n && calls < 60) {
    // A keeper-like cadence: the average catches up with the price between calls.
    await f.advance(601);
    const before = await splitter.pendingBuyback(weth.target), cap = (await weth.balanceOf(pool)) * 50n / 10000n;
    await mined(splitter.buyback()); calls++;
    const spent = before - await splitter.pendingBuyback(weth.target);
    assert.ok(spent > 0n && spent <= cap, `call ${calls}: within 0.5% of the pool`);
  }
  assert.equal(await splitter.pendingBuyback(weth.target), 0n, 'queue cleared');
  assert.ok(calls > 1, 'the queue was larger than 1% of the pool, so it took more than one call');
  assert.ok(await token.balanceOf(DEAD) > 0n);
});

test('E-1: pushing the price up in front of a buyback makes it revert; it cannot repeat in one block', async t => {
  const { f, pool, locker, splitter, weth, token, swap } = await graduated(t, 2000);
  for (let i = 0; i < 12; i++) {
    await swap(f.signers[3], weth.target, token.target, parseEther('8'), parseEther('8'));
    const bag = await token.balanceOf(f.addresses[3]);
    await mined(token.connect(f.signers[3]).approve(f.dex.router.target, bag));
    await swap(f.signers[3], token.target, weth.target, bag);
  }
  await mined(locker.collectFees());
  await f.advance(601);
  const pending = await splitter.pendingBuyback(weth.target);
  assert.ok(pending > (await weth.balanceOf(pool)) * 50n / 10000n, 'a backlog several calls deep');
  // The attacker's front-run: buy the token, moving the price well past 1.5%.
  const atk = f.signers[1];
  await swap(atk, weth.target, token.target, parseEther('6'), parseEther('6'));
  await assert.rejects(splitter.connect(atk).buyback(), /price away from average/, 'the buyback refuses the inflated price');
  assert.equal(await splitter.pendingBuyback(weth.target), pending, 'nothing was spent');
  // The attacker sells back; once the price is back near its average, the buyback works again.
  const bag = await token.balanceOf(f.addresses[1]);
  await mined(token.connect(atk).approve(f.dex.router.target, bag));
  await swap(atk, token.target, weth.target, bag);
  await f.advance(601);
  // Two buybacks in one block: the second is refused.
  await f.provider.send('evm_setAutomine', [false]);
  try {
    const first = await splitter.buyback({ gasLimit: 3_000_000n }), second = await splitter.buyback({ gasLimit: 3_000_000n });
    await f.provider.send('evm_mine', []);
    const [a, b] = await Promise.all([first.wait().then(r => r.status, () => 0), second.wait().then(r => r.status, () => 0)]);
    assert.deepEqual([a, b], [1, 0], 'one buyback per block');
  } finally { await f.provider.send('evm_setAutomine', [true]); }
  assert.ok(await splitter.pendingBuyback(weth.target) < pending, 'the first one spent part of the queue');
});

test('standard tokens: 50/50 LP fees, nothing burned or queued, buyback refused', async t => {
  const { f, locker, splitter, weth, token, swap } = await graduated(t, 0);
  assert.equal(await splitter.buybackBps(), 0n);
  await swap(f.signers[3], weth.target, token.target, parseEther('0.3'), parseEther('0.3'));
  await mined(locker.collectFees());
  assert.equal(await splitter.pendingBuyback(weth.target), 0n);
  assert.equal(await splitter.burned(), 0n);
  const a = await splitter.claimable(weth.target, f.addresses[2]), b = await splitter.claimable(weth.target, await splitter.creator());
  assert.ok(b - a <= 1n && b >= a, '50/50 as before');
  await assert.rejects(splitter.buyback(), /no buyback/);
});
