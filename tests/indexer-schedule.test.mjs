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

test('a slow network does not hold the next pass back for the others, and a nudge syncs one network only', async () => {
  const indexer = service();
  const runs = { slow: 0, fast: 0 };
  const counted = (key, ms) => ({ ...entry(key, ms), index: { sync: async () => { runs[key]++; await sleep(ms); }, status: () => ({ indexedBlock: 1 }), tokens: () => [] } });
  indexer.entries.set('slow', counted('slow', 300));
  indexer.entries.set('fast', counted('fast', 10));
  const first = indexer.tick();
  await sleep(50);
  await indexer.tick();
  await indexer.tick();
  assert.equal(runs.fast, 3, 'the fast network synced on every pass');
  assert.equal(runs.slow, 1, 'the slow one was not started again while still running');
  await first;
  await indexer.tick('fast');
  assert.deepEqual(runs, { slow: 1, fast: 4 }, 'a nudge for one network leaves the others alone');
  assert.equal(indexer.running, false);
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

/** An entry whose index reports a tip and the trades above a height, like the real one. */
function feedEntry(key, { height = 10, trades = [] } = {}) {
  const state = { height, trades, asked: null };
  return {
    net: { key },
    validated: true,
    metadata: new Map(),
    index: {
      tip: () => ({ height: state.height }),
      tradesSince: height => { state.asked = height; return state.trades; },
      sync: async () => {},
      status: () => ({ indexedBlock: state.height }),
      tokens: () => [],
    },
    set(next) { Object.assign(state, next); },
    get asked() { return state.asked; },
  };
}

test('the feed gets only the trades a pass added, and never a replay of history', () => {
  const published = [];
  const indexer = new PublicIndexer({ networks: [], contracts: {}, dataDir: '.', metadataStore: {}, onTrades: (net, trades) => published.push([net, trades]), log: () => {} });
  const entry = feedEntry('base-sepolia');

  indexer.publishFresh(entry);
  assert.equal(published.length, 0, 'the first pass only records the tip');

  entry.set({ height: 12, trades: [{ tx: '0xa', height: 11 }, { tx: '0xb', height: 12 }] });
  indexer.publishFresh(entry);
  assert.equal(entry.asked, 10, 'it asks for what came after the last published height');
  assert.equal(published.length, 1);
  assert.equal(published[0][0], 'base-sepolia');
  assert.equal(published[0][1].length, 2);

  indexer.publishFresh(entry);
  assert.equal(published.length, 1, 'an unchanged tip publishes nothing');

  entry.set({ height: 9, trades: [] });
  indexer.publishFresh(entry);
  assert.equal(published.length, 1, 'a rollback publishes nothing and it resynchronises from the new tip');
});
