// The simulation survives restarts: actions are journaled and replayed with their original times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  assert.deepEqual(second.config.simulation, { durable: true, replayed: 2, skipped: 0 });
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
