// The keeper's two failure modes found in the pre-mainnet audit: two instances acting on one signer, and a payout
// push that dies because a recipient already claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2Keeper } from '../apps/api/v2-keeper.mjs';

const dir = mkdtempSync(join(tmpdir(), 'v2k-lease-'));
const files = [], open = [];
const dbPath = () => { const p = join(dir, `k${files.length}.db`); files.push(p); return p; };

test.after(async () => { for (const k of open) await k.close(); rmSync(dir, { recursive: true, force: true }); });

/** A keeper whose jobs only record that they ran. */
function keeper(path, clock = { now: 1_700_000_000 }) {
  const k = new V2Keeper({ workers: [{ chain: 'test', net: { chainId: 1 } }], path, now: () => clock.now });
  k.calls = [];
  for (const job of ['fees', 'airdrop', 'holder', 'creator', 'flywheel']) k[job] = async () => { k.calls.push(job); };
  open.push(k);
  return k;
}

test('two keepers on one database cannot both act', async () => {
  const path = dbPath();
  const a = keeper(path), b = keeper(path);

  await Promise.all([a.tick(), b.tick()]);

  const ran = a.calls.length + b.calls.length;
  assert.equal(ran, 5, `exactly one instance ran the five jobs, got ${ran} (a=${a.calls.length}, b=${b.calls.length})`);

  // The loser may try again only after the winner released the lease.
  await b.tick();
  assert.equal(a.calls.length + b.calls.length, 10, 'the next tick runs again once the lease is free');
});

test('a keeper that lost the lease mid-cycle stops before the next job', async () => {
  const path = dbPath();
  const clock = { now: 1_700_000_000 };
  const a = keeper(path, clock), b = keeper(path, clock);

  // While a's first job runs, b takes the lease as if a had stalled.
  a.fees = async () => {
    a.calls.push('fees');
    b.db.prepare('UPDATE v2k_lock SET owner=?,expires=? WHERE id=1').run('other', clock.now + 900);
  };

  await a.tick();
  assert.deepEqual(a.calls, ['fees'], 'a stopped after losing the lease instead of paying twice');
  assert.equal(a.busy, false, 'the lease failure did not leave the keeper stuck');
});

test('a rejected batch is retried one recipient at a time', async () => {
  const k = keeper(dbPath());
  const paid = [];
  const failOne = new Set(['0xbad']);

  const sendBatch = async batch => ({ wait: async () => { throw new Error('AlreadyPaid'); } });
  const sendOne = async entry => ({ wait: async () => {
    if (failOne.has(entry.account)) throw new Error('AlreadyPaid');
    paid.push(entry.account);
  } });

  const entries = [{ account: '0xa' }, { account: '0xbad' }, { account: '0xc' }];
  const count = await k.pushBatches(entries, sendBatch, sendOne);

  assert.equal(count, 2, 'the two payable recipients are paid');
  assert.deepEqual(paid, ['0xa', '0xc'], 'the already-paid recipient is skipped, not fatal');
});

test('a healthy batch is not paid twice and does not fall back', async () => {
  const k = keeper(dbPath());
  let singles = 0;
  const count = await k.pushBatches(
    [{ account: '0xa' }, { account: '0xb' }],
    async batch => ({ wait: async () => batch.length }),
    async () => { singles++; return { wait: async () => {} }; },
  );
  assert.equal(count, 2);
  assert.equal(singles, 0, 'the fallback runs only when a batch fails');
});
