// Two launch guarantees (23 Oct 2026, Malik):
// 1. A curve is always tradable. EVM (atomic factory): the completing buy graduates in the same transaction or reverts,
//    so a curve is never "complete but not graduated" and never needs reopening (atomic-graduation.test.mjs).
//    Solana: the site sends the completing buy and the PumpSwap migration in ONE transaction (solana.test.mjs).
// 2. Token details are published only in the launch transaction, never afterwards. The server refuses the old
//    after-launch path; launchpads that cannot include details refuse to launch (launch-capabilities.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../apps/api/server.mjs';
import { dexFixture, launch, complete, mined } from './helpers/dex-fixture.mjs';

test('the after-launch metadata endpoints are gone (410) and the page offers no after-launch publishing', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const { csrf } = await (await fetch(`${app.url}/api/config`)).json();
  for (const path of ['/api/public/metadata/prepare', '/api/public/metadata/save']) {
    const res = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': csrf }, body: JSON.stringify({ network: 'base-sepolia', token: '0x' + '1'.repeat(40) }) });
    assert.equal(res.status, 410, path); assert.match((await res.json()).error, /only at launch/);
  }
  const page = await (await fetch(`${app.url}/token-page.mjs`)).text();
  assert.ok(!/public\/metadata\/(prepare|save)/.test(page), 'no client code calls the old endpoints');
});

test('EVM atomic curve: there is no state in which it is complete but not graduated, so reopen never applies', async t => {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' }), l = await launch(f);
  await f.advance(61);
  await assert.rejects(l.curve.reopen(), /not reopenable/, 'a trading curve cannot be reopened (it is open)');
  await complete(f, l);
  assert.equal(await l.curve.complete(), true);
  assert.notEqual(await l.curve.pool(), '0x0000000000000000000000000000000000000000', 'complete always means graduated: trading moved to the DEX');
  await f.advance(86400 * 2);
  await assert.rejects(l.curve.reopen(), /not reopenable/, 'and a graduated curve is never reopened');
});
