// The public indexer's pass used to walk the networks one after another, so a slow RPC on one chain delayed the trades
// of every other chain, and the API only shows a trade once its chain has been read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicIndexer } from '../apps/api/public-indexer.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** An indexer with no configured networks, so the pass can be driven with synthetic entries. */
function service() {
  return new PublicIndexer({ networks: [], contracts: {}, dataDir: '.', metadataStore: { retainPublished() {}, resolve: async () => ({}) }, log: () => {} });
}

function entry(key, ms, { tokens = [] } = {}) {
  return {
    net: { key },
    validated: true,
    metadata: new Map(),
    index: {
      sync: async () => { await sleep(ms); },
      status: () => ({ indexedBlock: 1, lag: 0 }),
      tokens: () => tokens,
    },
  };
}

test('networks sync side by side instead of one after another', async () => {
  const indexer = service();
  for (const key of ['a', 'b', 'c']) indexer.entries.set(key, entry(key, 120));

  const started = Date.now();
  await indexer.tick();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 300, `three 120 ms networks finished in ${elapsed} ms; sequentially that is at least 360 ms`);
});

test('a pass that is still running is not started twice', async () => {
  const indexer = service();
  let runs = 0;
  indexer.entries.set('a', { ...entry('a', 150), index: { sync: async () => { runs++; await sleep(150); }, status: () => ({ indexedBlock: 1 }), tokens: () => [] } });

  const first = indexer.tick();
  const second = indexer.tick();
  await Promise.all([first, second]);

  assert.equal(runs, 1, 'the overlapping pass returned immediately');
});

test('one failing network does not stop the others, and is reported as a code', async () => {
  const indexer = service();
  indexer.entries.set('slow', entry('slow', 10));
  indexer.entries.set('broken', {
    net: { key: 'broken' },
    validated: true,
    metadata: new Map(),
    index: { sync: async () => { throw Object.assign(new Error('rpc down at https://secret.example'), { code: 'ECONNREFUSED' }); }, status: () => ({}), tokens: () => [] },
  });
  indexer.entries.set('after', entry('after', 10));

  await indexer.tick();

  assert.equal(indexer.entries.get('broken').errorCode, 'ECONNREFUSED');
  assert.equal(indexer.entries.get('broken').error, 'Indexing unavailable; retrying.');
  assert.ok(indexer.entries.get('slow').lastSuccess, 'the healthy networks still synced');
  assert.ok(indexer.entries.get('after').lastSuccess);
});
