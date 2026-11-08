// V2 tokens on the site: the V2 trading indexer lists them, records every trade with the real trader and reads each
// token's own fee and five fee ledgers from the hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, formatUnits } from 'ethers';
import { v2Fixture, launchV2, trade, mined, parse } from './helpers/v2-fixture.mjs';
import { V2Indexer, verifyV2Deployment } from '../packages/indexer/v2-indexer.mjs';
import { V2_MODEL } from '../packages/core/v2-economics.mjs';

test('V2 launches, trades and fee ledgers are indexed for the site', async t => {
  const f = await v2Fixture(t, { vaults: true });
  await verifyV2Deployment(f.provider, { factory: f.factory.target, hook: f.hook.target, router: f.router.target, poolManager: f.manager.target });
  await assert.rejects(verifyV2Deployment(f.provider, { factory: f.factory.target, hook: f.hook.target, router: f.router.target, poolManager: f.factory.target }), /router mismatch/);
  const index = new V2Indexer({ provider: f.provider, factory: f.factory.target, hook: f.hook.target, poolManager: f.manager.target, router: f.router.target });
  t.after(() => index.close());
  const l = await launchV2(f, { feeBps: 300, firstBuy: parseEther('0.2'), symbol: 'HOPE' });
  await f.advance(61);
  const buy = await trade(f, l, { signer: f.signers[1], buy: true, amount: parseEther('1') });
  await trade(f, l, { signer: f.signers[2], buy: true, amount: parseEther('0.5') });
  await trade(f, l, { signer: f.signers[1], buy: false, amount: (await l.token.balanceOf(f.addresses[1])) / 4n });
  await index.sync();
  const [item] = index.listings();
  assert.equal(item.address, l.token.target.toLowerCase());
  assert.equal(item.model, V2_MODEL); assert.equal(item.feeBps, 300); assert.equal(item.curveModel, 20);
  assert.deepEqual(item.feeSchedule, { base: 300, start: 9000, window: 60 });
  assert.equal(item.symbol, 'HOPE'); assert.equal(item.pair, 'native');
  assert.ok(Number(item.devBoughtPct) > 0 && Number(item.devBoughtPct) <= 3, 'the first buy is within the 3% cap');
  // Trades, newest first: launch first buy, two buys and a sell, each with its real trader.
  const trades = index.trades(item.address);
  assert.deepEqual(trades.map(x => x.side).reverse(), ['buy', 'buy', 'buy', 'sell']);
  assert.equal(trades.at(-1).launch, true);
  assert.equal(trades[0].account.toLowerCase(), f.addresses[1].toLowerCase());
  assert.equal(trades[1].account.toLowerCase(), f.addresses[2].toLowerCase());
  const [fee] = parse(f.hook, buy, 'Fee');
  assert.equal(trades[2].feeRaw, fee.args.fee.toString()); assert.equal(trades[2].feeBps, 300);
  // The snapshot: the token's own fee and its five ledgers, as the hook reports them.
  const snap = index.snapshot(item.address), [owed] = await f.hook.ledgers(l.token.target);
  assert.equal(snap.feeBps, 300); assert.equal(snap.tokenFeeBps, 300); assert.equal(snap.antiSnipeActive, false);
  assert.equal(snap.feeLedgers.owed.creator, formatUnits(owed[0], 18)); assert.equal(snap.feeLedgers.owed.traderAirdrop, formatUnits(owed[1], 18));
  assert.equal(snap.creatorFees, formatUnits(owed[0], 18)); assert.equal(snap.protocolFees, formatUnits(owed[4], 18));
  assert.equal(snap.graduated, false); assert.ok(Number(snap.remainingBuy) > 0);
  // Graduation, then fees paid out: ledgers show paid, supply shows the launch dust burned.
  await trade(f, l, { buy: true, amount: parseEther('15') });
  await mined(f.hook.withdrawFees(l.token.target));
  await index.sync();
  const after = index.snapshot(item.address);
  assert.equal(after.graduated, true); assert.equal(after.feeBps, 300, 'the token keeps its own fee after graduating');
  assert.equal(after.feeLedgers.owed.flywheel, '0.0'); assert.ok(Number(after.feeLedgers.paid.flywheel) > 0);
  assert.equal(after.supply, formatUnits(await l.token.totalSupply(), 18));
  assert.equal(index.status().model, V2_MODEL);
});
