// Model 11 phase 4: the v4 indexer on a local cancun chain with Uniswap's own PoolManager. Every trade path is indexed
// once with its fee (the creator's first buy, the Elpida router, another router), buybacks are not trades, and the
// snapshot's positions math (packages/core/v4-model.mjs) matches the hook's own views to the wei.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits } from 'ethers';
import { v4Fixture, v4Art, launchV4, mined, parse, swap, poolPrice } from './helpers/v4-fixture.mjs';
import { V4Indexer, v4PoolId, v4PoolKey, verifyV4Deployment } from '../packages/indexer/v4-indexer.mjs';
import { V4_MODEL, firstBuyOut, launchPositions, sqrtPriceAtTick, tickAtSqrtPrice, v4FeeBps, v4PoolState } from '../packages/core/v4-model.mjs';

const FAR = 2n ** 40n;
async function setup(t) {
  const f = await v4Fixture(t);
  f.v4router = await f.deploy(v4Art('ElpidaV4Router'), f.manager.target, f.hook.target);
  f.index = (options = {}) => new V4Indexer({ provider: f.provider, factory: f.factory.target, hook: f.hook.target, poolManager: f.manager.target, router: f.v4router.target, chainId: 31337, ...options });
  f.buy = async (l, signer, value) => mined(f.v4router.connect(signer).buy(l.token.target, value, 0n, await signer.getAddress(), FAR, { value }));
  f.sell = async (l, signer, amount) => { await mined(l.token.connect(signer).approve(f.v4router.target, amount)); return mined(f.v4router.connect(signer).sell(l.token.target, amount, 0n, await signer.getAddress(), FAR)); };
  return f;
}

test('v4 model math: TickMath and the hook\'s launch sizing, replayed in JavaScript', async t => {
  for (const tick of [-887272, -200000, -23030, -1, 0, 1, 10, 23030, 199990, 887271]) {
    const s = sqrtPriceAtTick(tick);
    assert.equal(tickAtSqrtPrice(s), tick, `tick ${tick}`);
    assert.equal(tickAtSqrtPrice(s + 1n), tick);
  }
  const f = await setup(t), first = parseEther('0.05');
  const l = await launchV4(f, { firstBuy: first });
  const p = launchPositions(f.virtualQuote);
  assert.equal(p.upperTick, Number(l.launched.upperTick)); assert.equal(p.lowerTick, Number(l.launched.lowerTick));
  assert.equal(p.saleLiquidity, l.launched.saleLiquidity); assert.equal(p.upperLiquidity, l.launched.upperLiquidity);
  assert.equal(firstBuyOut(f.virtualQuote, first), l.bought, 'the launch form\'s first-buy estimate is exact');
  const { sqrtPrice } = await poolPrice(f, l), launch = await f.hook.launches(l.token.target);
  const state = v4PoolState({ upperTick: launch.upperTick, lowerTick: launch.lowerTick, saleLiquidity: launch.saleLiquidity, upperLiquidity: launch.upperLiquidity, milestoneLiquidity: launch.milestoneLiquidity, graduated: launch.graduated }, sqrtPrice);
  assert.equal(state.saleRemaining, await f.hook.saleRemaining(l.token.target));
  assert.ok(state.saleSold - l.bought <= 1n && state.saleSold >= l.bought, 'what the first buy took left the sale range (to the wei, rounding down twice)');
  assert.deepEqual([0, 30, 59, 60, 600].map(e => v4FeeBps(e)), [9000, 4562, 272, 125, 125]);
  assert.equal(v4FeeBps(0, true), 100);
});

test('v4 indexer: launches, every trade path once with its fee, holders and candles', async t => {
  const f = await setup(t), [creator, buyer, other, , whale] = f.signers;
  await mined(f.factory.connect(f.signers[2]).setPartner(f.addresses[0], 1000, (await f.now()) + 86400));
  const l = await launchV4(f, { firstBuy: parseEther('0.02'), uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' });
  await f.advance(120);
  const b1 = await f.buy(l, buyer, parseEther('0.1'));
  const tokens = parse(f.v4router, b1, 'Swapped')[0].args.tokenAmount;
  await f.sell(l, buyer, tokens / 3n);
  const viaTest = await swap(f, l, { signer: other, buy: true, amount: parseEther('0.03') });
  const index = f.index();
  await index.sync();
  const [row] = index.listings();
  assert.equal(row.model, V4_MODEL); assert.equal(row.curveModel, 11); assert.equal(row.pair, 'native'); assert.equal(row.quoteSymbol, 'ETH');
  assert.equal(row.poolId, v4PoolId(v4PoolKey(l.key[0], l.key[1], l.key[4])));
  assert.equal(row.metadataURI.startsWith('ipfs://'), true); assert.equal(row.buybackBps, 1000);
  assert.equal(row.creator, f.addresses[0]); assert.equal(row.devBoughtRaw, l.bought.toString());
  const trades = index.trades(l.token.target).reverse();
  assert.deepEqual(trades.map(x => [x.side, x.accountBasis.split(' ')[0]]), [['buy', 'launch'], ['buy', 'Elpida'], ['sell', 'Elpida'], ['buy', 'transaction']], 'buybacks are not trades');
  assert.equal(trades[0].launch, true); assert.equal(trades[0].account, f.addresses[0]);
  assert.equal(trades[1].account, f.addresses[1]); assert.equal(trades[1].quoteRaw, parseEther('0.1').toString(), 'gross, fee included');
  assert.equal(trades[1].feeRaw, (parseEther('0.1') * 125n / 10000n).toString()); assert.equal(trades[1].feeBps, 125);
  assert.equal(trades[1].tokenRaw, tokens.toString());
  const swapped = parse(f.v4router, (await f.provider.getTransactionReceipt(trades[2].hash)), 'Swapped')[0];
  assert.equal(trades[2].quoteRaw, swapped.args.quoteAmount.toString(), 'a sell is net of the fee, what the seller got');
  assert.equal(trades[3].account, f.addresses[2]); assert.equal(trades[3].hash, viaTest.hash);
  const burns = index.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.name')='BuybackBurned'").all();
  assert.ok(burns.length >= 3, 'the partner share burned on each fee');
  // Snapshot: price from slot0, positions math against the hook's views.
  const s = index.snapshot(l.token.target), { sqrtPrice } = await poolPrice(f, l);
  assert.equal(s.sqrtPriceX96, sqrtPrice.toString()); assert.equal(s.graduated, false); assert.equal(s.liquidityLocked, true);
  assert.equal(parseUnits(s.saleCap, 18) - parseUnits(s.sold, 18), await f.hook.saleRemaining(l.token.target));
  assert.equal(s.feeBps, 125); assert.ok(Number(s.spotPrice) > 0 && Number(s.fdvQuote) > 0);
  assert.equal(parseUnits(s.burned, 18), (await f.hook.launches(l.token.target)).buybackBurned); assert.ok(Number(s.burned) > 0);
  // Quote in the pool: every Swap's quote into the pool, buybacks included (no donations here).
  const swaps = index.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.name')='Swap'").all().map(r => JSON.parse(r.data).args);
  const inPool = swaps.reduce((n, a) => n - BigInt(a[2]), 0n);
  assert.ok(parseUnits(s.reserve, 18) <= inPool && inPool - parseUnits(s.reserve, 18) <= 16n, 'positions math within rounding of the pool\'s own accounting');
  const holders = index.holders(l.token.target), excluded = [f.manager.target, f.hook.target, '0x000000000000000000000000000000000000dEaD'].map(a => a.toLowerCase());
  assert.ok(holders.length >= 3 && holders.every(h => !excluded.includes(h.address)));
  assert.ok(index.candles(l.token.target, 60).length >= 1);
  // A one-block-at-a-time index sees exactly the same history.
  const step = f.index({ batchSize: 1 }); await step.sync();
  assert.deepEqual(step.trades(l.token.target).map(x => x.hash + x.index), index.trades(l.token.target).map(x => x.hash + x.index));
  // The milestone: 1% after it, nothing left to buy on the sale, still locked.
  await f.buy(l, whale, parseEther('30'));
  await index.sync();
  const after = index.snapshot(l.token.target);
  assert.equal(after.graduated, true); assert.equal(after.complete, true); assert.equal(after.remainingBuy, '0'); assert.equal(after.feeBps, 100); assert.equal(after.liquidityLocked, true);
  assert.equal(after.sold, after.saleCap);
  assert.equal(index.db.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(data,'$.name')='Milestone'").get().n, 1);
  await verifyV4Deployment(f.provider, { factory: f.factory.target, hook: f.hook.target, router: f.v4router.target, poolManager: f.manager.target });
  await index.close(); await step.close();
});

test('v4 indexer: USDC pairs, a remaining-buy that reaches the milestone, and other pools on the same PoolManager are ignored', async t => {
  const f = await setup(t), buyer = f.signers[1];
  const l = await launchV4(f, { usdc: true, firstBuy: 10n * 10n ** 6n });
  const native = await launchV4(f, { symbol: 'TWO', name: 'Two' });
  const index = f.index(); await index.sync();
  const usdcRow = index.listings().find(r => r.address === l.token.target.toLowerCase());
  assert.equal(usdcRow.pair, 'usdc'); assert.equal(usdcRow.quoteDecimals, 6);
  assert.equal(index.tokens().length, 2);
  await f.advance(120);
  const remaining = parseUnits(index.snapshot(l.token.target).remainingBase, 6);
  await mined(f.usdc.connect(buyer).approve(f.v4router.target, remaining));
  const receipt = await mined(f.v4router.connect(buyer).buy(l.token.target, remaining, 0n, f.addresses[1], FAR));
  assert.equal(parse(f.hook, receipt, 'Milestone').length, 1, 'remainingBase is enough to reach the milestone');
  await index.sync();
  assert.equal(index.snapshot(l.token.target).graduated, true);
  assert.equal(index.snapshot(native.token.target).graduated, false);
  assert.equal(index.trades(native.token.target).length, 0);
  await index.close();
});
