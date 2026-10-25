// The simulation survives restarts: actions are journaled and replayed with their original times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/api/curve-runtime.mjs';

test('simulation journal replays launches and trades after a restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-journal-')), journalPath = join(dir, 'simulation-journal.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await createRuntime({ seed: false, journalPath });
  const launched = await first.transact('launch', { name: 'Durable', symbol: 'KEEP', pair: 'native', firstBuy: '0.02', account: '0' });
  await first.transact('buy', { token: launched.token, amount: '0.01', account: '1', slippage: '1' });
  const before = first.listings().find(t => t.address === launched.token);
  const trades = first.indexer.trades(launched.token);
  await first.close();
  assert.equal(readFileSync(journalPath, 'utf8').trim().split('\n').length, 2, 'two actions journaled');

  const second = await createRuntime({ seed: false, journalPath });
  t.after(() => second.close());
  assert.deepEqual(second.config.simulation, { durable: true, replayed: 2, skipped: 0, malformed: 0, failures: [] });
  const after = second.listings().find(t => t.address === launched.token);
  assert.ok(after, 'same token address after replay');
  assert.equal(after.reserve, before.reserve, 'same curve reserve');
  assert.equal(after.sold, before.sold, 'same tokens sold');
  const replayedTrades = second.indexer.trades(launched.token);
  assert.equal(replayedTrades.length, trades.length);
  for (const [i, trade] of replayedTrades.entries()) assert.ok(Math.abs(trade.timestamp - trades[i].timestamp) <= 3, 'original trade time restored');
  assert.ok(Math.abs((await second.provider.getBlock('latest')).timestamp - Date.now() / 1000) < 30, 'chain clock caught up to now');
  // New actions keep working and are journaled after the replayed ones.
  await second.transact('buy', { token: launched.token, amount: '0.005', account: '0', slippage: '1' });
  assert.equal(readFileSync(journalPath, 'utf8').trim().split('\n').length, 3);
});

test('seeded demo launches are journaled so replays keep every token address', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-journal-')), journalPath = join(dir, 'simulation-journal.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await createRuntime({ seed: true, journalPath });
  const launched = await first.transact('launch', { name: 'After seed', symbol: 'AFTER', pair: 'native', firstBuy: '0.01', account: '0' });
  const addresses = first.listings().map(t => t.address).sort();
  await first.close();
  const second = await createRuntime({ seed: true, journalPath });
  t.after(() => second.close());
  assert.equal(second.config.simulation.replayed, 4, 'three demo launches and one user launch');
  assert.deepEqual(second.listings().map(t => t.address).sort(), addresses);
  assert.ok(second.listings().some(t => t.address === launched.token));
});
test('a journal entry that cannot replay is reported with its reason instead of vanishing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-journal-')), journalPath = join(dir, 'simulation-journal.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = Date.now();
  writeFileSync(journalPath, [
    JSON.stringify({ action: 'launch', body: { name: 'Kept', symbol: 'KEPT', pair: 'native', firstBuy: '0.01', account: '0' }, at }),
    JSON.stringify({ action: 'buy', body: { token: '0x00000000000000000000000000000000000000ff', amount: '0.01', account: '0', slippage: '1' }, at: at + 1000 }),
    '{"action":"launch","body":',
  ].join('\n') + '\n');

  const runtime = await createRuntime({ seed: false, journalPath });
  t.after(() => runtime.close());

  assert.equal(runtime.config.simulation.replayed, 1, 'the good entry replayed');
  assert.equal(runtime.config.simulation.skipped, 1, 'the failed entry is counted');
  assert.equal(runtime.config.simulation.malformed, 1, 'the torn line is counted, not ignored');
  assert.equal(runtime.config.simulation.failures.length, 1);
  assert.equal(runtime.config.simulation.failures[0].action, 'buy');
  assert.ok(runtime.config.simulation.failures[0].reason, 'the failure records why it failed');
  assert.equal(runtime.listings().length, 1, 'the entry before it still replayed');
});

test('strict replay refuses to start rather than serve a partial economy', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-journal-')), journalPath = join(dir, 'simulation-journal.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(journalPath, '{"action":"launch","body":\n');
  const previous = process.env.ELPIDA_REPLAY_STRICT;
  process.env.ELPIDA_REPLAY_STRICT = '1';
  t.after(() => { if (previous === undefined) delete process.env.ELPIDA_REPLAY_STRICT; else process.env.ELPIDA_REPLAY_STRICT = previous; });
  const before = readFileSync(journalPath, 'utf8');
  // seed:true proves the refusal happens before demo launches are appended to a journal that is already damaged.
  await assert.rejects(() => createRuntime({ seed: true, journalPath }), /partial economy/);
  assert.equal(readFileSync(journalPath, 'utf8'), before, 'a refused start must not touch the journal');
});
