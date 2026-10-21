// Mainnet checklist A6: restart and recovery. The public indexer reads from a third-party RPC that can drop calls at any
// point, and the service restarts on every deploy. These tests inject RPC failures in the middle of a sync, restart the
// durable index from its SQLite file between failures, and require the end state to be IDENTICAL to a clean index built
// from scratch on a reliable provider: same trades (none skipped, none duplicated), same snapshots, same holders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/api/curve-runtime.mjs';
import { EvmIndexer } from '../packages/indexer/evm-indexer.mjs';

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Wraps a provider so that calls fail on a schedule: `plan(n, method)` returns true to fail call number n. */
function flaky(provider, plan) {
  let n = 0;
  const stats = { calls: 0, failures: 0 };
  const proxy = new Proxy(provider, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || !['send', 'getLogs', 'getBlock', 'getBlockNumber', 'call', 'getNetwork', 'getTransactionReceipt'].includes(prop)) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args) => {
        n++; stats.calls++;
        if (plan(n, prop, args)) { stats.failures++; const e = new Error(`injected RPC failure on ${String(prop)}`); e.code = 'ECONNRESET'; throw e; }
        return value.apply(target, args);
      };
    },
  });
  return { provider: proxy, stats };
}

async function activity(runtime) {
  // Two tokens, both demo accounts, buys and sells interleaved across many blocks.
  const a = (await runtime.transact('launch', { name: 'Recovery One', symbol: 'REC1', pair: 'native', firstBuy: '0.01' })).token.toLowerCase();
  const b = (await runtime.transact('launch', { name: 'Recovery Two', symbol: 'REC2', pair: 'native', firstBuy: '0.02' })).token.toLowerCase();
  for (let i = 0; i < 6; i++) {
    await runtime.transact('buy', { token: i % 2 ? a : b, amount: String(0.01 + i / 100), account: String(i % 2) });
    if (i % 3 === 2) await runtime.transact('sell', { token: i % 2 ? a : b, amount: '100000', account: String(i % 2) });
  }
  return [a, b];
}

function compare(subject, reference, tokens, label) {
  for (const token of tokens) {
    assert.deepEqual(subject.trades(token), reference.trades(token), `${label}: trades for ${token} (none skipped or duplicated)`);
    assert.deepEqual(subject.snapshot(token), reference.snapshot(token), `${label}: snapshot for ${token}`);
    assert.deepEqual(subject.holders(token), reference.holders(token), `${label}: holders for ${token}`);
  }
  assert.equal(subject.status().indexedBlock, reference.status().indexedBlock, `${label}: same indexed block`);
}

async function withRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-recovery-'));
  const runtime = await createRuntime({ seed: false });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const make = (provider, opts = {}) => new EvmIndexer({ provider, factory: runtime.config.local.factory, contracts: runtime.config.contracts, fromBlock: runtime.indexer.fromBlock, ...opts });
  return { dir, runtime, make };
}

for (const batchSize of [1, 100]) {
  test(`RPC failures mid-sync plus restarts converge to the exact clean index (batch size ${batchSize})`, async t => {
    const { dir, runtime, make } = await withRuntime(t);
    const tokens = await activity(runtime);
    const reference = make(runtime.provider, { batchSize: 1 }); await reference.sync();
    const tradeCount = tokens.reduce((n, tk) => n + reference.trades(tk).length, 0);
    assert.ok(tradeCount >= 10, `the reference saw the activity (${tradeCount} trades)`);

    // 5% of RPC calls fail at random (seeded, so a failure is reproducible; real endpoints fail far less often). Each block is
    // all-or-nothing and one busy block needs many reads, so much higher rates mostly measure retries. After every second failure the
    // "service" restarts: the index is closed and reopened from its SQLite file.
    const rand = prng(1000 + batchSize);
    const { provider, stats } = flaky(runtime.provider, () => rand() < 0.05);
    const path = join(dir, `index-${batchSize}.sqlite`);
    let index = make(provider, { path, batchSize }), failures = 0, restarts = 0;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await index.sync(); break; }
      catch (error) {
        assert.match(String(error.message), /injected RPC failure/, 'only injected failures interrupt the sync');
        failures++;
        if (failures % 2 === 0) { await index.close(); index = make(provider, { path, batchSize }); restarts++; }
      }
    }
    t.diagnostic(`calls=${stats.calls} injected failures=${stats.failures} interrupted syncs=${failures} restarts=${restarts}`);
    assert.ok(failures > 3 && restarts > 1, 'the sync really was interrupted and restarted several times');
    compare(index, reference, tokens, 'after flaky sync');
    await index.close();

    // One more restart with a healthy provider changes nothing.
    const reopened = make(runtime.provider, { path, batchSize });
    await reopened.sync();
    compare(reopened, reference, tokens, 'after a clean restart');
    await reopened.close(); await reference.close();
  });
}

test('a full RPC outage during new trading does not advance or corrupt the index; recovery catches up exactly', async t => {
  const { dir, runtime, make } = await withRuntime(t);
  const tokens = await activity(runtime);
  let down = false;
  const { provider } = flaky(runtime.provider, () => down);
  const path = join(dir, 'outage.sqlite');
  const index = make(provider, { path, batchSize: 100 });
  await index.sync();
  const before = index.status().indexedBlock, beforeTrades = tokens.map(tk => index.trades(tk).length);

  down = true;
  await runtime.transact('buy', { token: tokens[0], amount: '0.03', account: '1' });
  await runtime.transact('sell', { token: tokens[1], amount: '50000', account: '0' });
  for (let i = 0; i < 3; i++) await assert.rejects(index.sync(), /injected RPC failure/);
  assert.equal(index.status().indexedBlock, before, 'the index does not claim blocks it could not read');
  assert.deepEqual(tokens.map(tk => index.trades(tk).length), beforeTrades, 'no partial trades during the outage');

  down = false;
  await index.sync();
  const reference = make(runtime.provider, { batchSize: 1 }); await reference.sync();
  compare(index, reference, tokens, 'after the outage');
  assert.equal(index.trades(tokens[0]).length, beforeTrades[0] + 1); assert.equal(index.trades(tokens[1]).length, beforeTrades[1] + 1);
  await index.close(); await reference.close();
});
