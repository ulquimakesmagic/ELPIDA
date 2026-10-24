// AIZEN (Base Sepolia, 23 Oct 2026): a curve on an older launchpad completed, did not graduate within its 24 h grace,
// and was reopened. A reopened curve is fully sold but no longer complete, so `completionQuote()` reverts (an
// arithmetic panic: nothing is left to buy until a holder sells). The public indexer called it for every curve that is
// not complete and stopped at the reopen block. This reproduces that on a local chain and checks the index moves on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { EvmIndexer } from '../packages/indexer/evm-indexer.mjs';
import { v3PoolAbi } from '../packages/core/uniswap.mjs';
import { dexFixture, launch, complete, mined, art } from './helpers/dex-fixture.mjs';

const GRACE = 3600;

test('a reopened, fully sold curve: selling works, buying waits for a seller, and the indexer does not stop', async t => {
  const f = await dexFixture(t, { grace: GRACE });
  const start = await f.provider.getBlockNumber();
  const l = await launch(f), curve = l.curve;
  await complete(f, l);
  assert.equal(await curve.complete(), true); assert.equal(await curve.pool(), ZeroAddress, 'the older factory graduates in a separate step');
  await f.advance(GRACE + 1);
  await mined(curve.connect(f.signers[3]).reopen());
  assert.equal(await curve.complete(), false);
  assert.equal(await curve.sold(), await curve.SALE_CAP(), 'still fully sold');
  await assert.rejects(curve.completionQuote(), 'the contract reverts: nothing is left to buy (audit finding F-8)');

  const contracts = { factory: art('ElpidaDexFactory'), curve: art('ElpidaDexCurve'), token: art('ElpidaToken'), pool: art('ElpidaDexCurve'), dexPool: { abi: v3PoolAbi() }, locker: art('ElpidaV3FeeLocker'), splitter: art('ElpidaFeeSplitter') };
  const index = new EvmIndexer({ provider: f.provider, factory: f.factory.target, contracts, fromBlock: start, batchSize: 100 });
  await index.sync();
  assert.equal(index.status().error, null, 'the index passes the reopen block');
  let snap = index.snapshot(l.token.target);
  assert.equal(snap.complete, false); assert.equal(snap.soldOut, true); assert.equal(snap.remainingBuy, '0'); assert.equal(snap.remainingBase, '0');

  // A holder sells: tokens are available again, so buying (and completing again, then graduating) works.
  const seller = f.signers[0], held = await l.token.balanceOf(f.addresses[0]);
  await mined(l.token.connect(seller).approve(curve.target, held));
  await mined(curve.connect(seller).sell(held / 10n, 0n));
  assert.ok(await curve.completionQuote() > 0n, 'buyable again after a sale');
  await index.sync();
  snap = index.snapshot(l.token.target);
  assert.equal(snap.soldOut, false); assert.ok(Number(snap.remainingBuy) > 0);
  await index.close();
});

test('operations status warns once when an earlier launchpad index on a network is stuck', async () => {
  const { evaluateOperations } = await import('../apps/api/operations-health.mjs');
  const now = Date.now(), ok = { enabled: true, error: null, lastSuccess: new Date(now).toISOString(), lag: 2 };
  const codes = n => evaluateOperations({ now, startedAt: now - 3600000, networks: { 'base-sepolia': n }, durable: true, backup: { enabled: true, lastSuccess: new Date(now).toISOString(), intervalMs: 3600000 } }).incidents.map(i => [i.code, i.severity]).filter(([c]) => c.startsWith('indexer'));
  assert.deepEqual(codes({ ...ok, legacy: [{ error: null, lag: 3 }] }), []);
  assert.deepEqual(codes({ ...ok, legacy: [{ error: 'Indexing unavailable; retrying.', lag: 221000 }, { error: 'x', lag: 9 }] }), [['indexer_base-sepolia_legacy', 'warning']]);
});
