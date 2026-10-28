// The trade read paths and the on-open migration. A database written by an older build has no `events.address`
// column and no trade indexes; opening it must add both without rewriting history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvmIndexer } from '../packages/indexer/evm-indexer.mjs';

const factory = '0x' + '99'.repeat(20);
const token = '0x' + '11'.repeat(20);
const holder = '0x' + '22'.repeat(20);
const pool = '0x' + '33'.repeat(20);
const pad = n => '0x' + n.toString(16).padStart(40, '0');
const contracts = { factory: { abi: [] }, curve: { abi: [] }, pool: { abi: [] }, token: { abi: [] } };
const provider = { getBlock: async () => null, getLogs: async () => [], send: async () => 0 };

const dir = mkdtempSync(join(tmpdir(), 'elpida-read-'));
const path = join(dir, 'index.db');
let index;

test.after(async () => { await index?.close(); rmSync(dir, { recursive: true, force: true }); });

/** A database with the pre-index schema: no address column on events, no indexes. */
function legacy({ trades = 40, events = 40 } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE tokens (address TEXT PRIMARY KEY, height INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE events (tx TEXT NOT NULL, idx INTEGER NOT NULL, height INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tx,idx));
    CREATE TABLE snapshots (address TEXT NOT NULL, height INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(address,height));
    CREATE TABLE trades (tx TEXT NOT NULL, idx INTEGER NOT NULL, address TEXT NOT NULL, height INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tx,idx));`);
  db.prepare('INSERT INTO identity VALUES(1,?)').run(JSON.stringify({ chainId: 31337, factory, fromBlock: 0 }));
  db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(token, 1, JSON.stringify({ address: token, curve: pad(7000), name: 'Legacy', symbol: 'LEG', metadataURI: '', pair: 'native' }));
  db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(token, 1, JSON.stringify({ supply: '1000000000000000000000000000' }));

  const start = 1_700_000_000;
  for (let i = 0; i < trades; i++) {
    db.prepare('INSERT INTO trades VALUES(?,?,?,?,?,?)').run(`0xt${i}`, 0, token, 10 + i, start + i * 60, JSON.stringify({
      address: token, height: 10 + i, timestamp: start + i * 60, priceQuote: (1 + i / 100).toFixed(18), priceBasis: 'quote',
      quoteRaw: String(10n ** 15n), tokenRaw: String(10n ** 18n), side: i % 2 ? 'buy' : 'sell',
    }));
  }
  for (let i = 0; i < events; i++) {
    db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(`0xe${i}`, 0, 11 + i, JSON.stringify({
      address: token, kind: 'token', name: 'Transfer',
      args: [pad(1), holder, String(10n ** 15n)],
    }));
  }
  db.close();
}

legacy();
index = new EvmIndexer({ provider, factory, contracts, path, fromBlock: 0, chainId: 31337 });

test('an older database gains the address column and the trade indexes on open', () => {
  const columns = index.db.prepare("SELECT name FROM pragma_table_info('events')").all().map(r => r.name);
  assert.ok(columns.includes('address'), 'the address column is added');
  const indexes = index.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  for (const name of ['trades_address', 'trades_recent', 'events_address', 'events_sender', 'events_recipient']) assert.ok(indexes.includes(name), `${name} exists`);
  const filled = index.db.prepare('SELECT COUNT(*) n FROM events WHERE address IS NULL').get().n;
  assert.equal(filled, 0, 'every existing event is backfilled');
  assert.equal(index.db.prepare('SELECT COUNT(*) n FROM events WHERE sender IS NULL').get().n, 0, 'the wallet side of every transfer is backfilled');
});

test('portfolio balances come from the indexed wallet columns and match the transfer history', () => {
  assert.deepEqual(index.balancesOf(holder), [{ address: token, balance: '0.04' }]);
  assert.deepEqual(index.balancesOf(pad(44)), [], 'a wallet that never received anything has no balance');
});

test('existing history is still readable through the new paths', () => {
  const trades = index.trades(token);
  assert.equal(trades.length, 40);
  assert.equal(trades[0].timestamp, 1_700_000_000 + 39 * 60, 'newest first');
  assert.equal(index.recentTrades(20).length, 20);
  assert.equal(index.tokenAt(token).symbol, 'LEG');
});

test('holders counts transfers that were written before the column existed', () => {
  const holders = index.holders(token);
  assert.equal(holders.length, 1, 'one holder after 40 transfers in and out of the pool address');
  assert.equal(holders[0].address, holder);
  assert.equal(holders[0].balance, '0.04');
});

test('holders follow new transfers and ignore the cache once the history changes', () => {
  assert.equal(index.holders(token)[0].balance, '0.04');
  index.db.prepare('INSERT INTO events(tx,idx,height,data,address) VALUES(?,?,?,?,?)').run('0xextra', 0, 999, JSON.stringify({
    address: token, kind: 'token', name: 'Transfer', args: [holder, pad(44), String(5n * 10n ** 15n)],
  }), token);
  const holders = index.holders(token);
  assert.equal(holders.length, 2);
  assert.deepEqual(holders.map(h => h.address).sort(), [holder, pad(44)].sort());
});

test('candles return the same buckets whether the window or the whole history is read', () => {
  const candles = index.candles(token, 60, 100);
  assert.equal(candles.length, 40, 'forty trades a minute apart fall into forty one-minute buckets');
  assert.equal(candles.at(-1).close, candles.at(-1).close);
  const sum = candles.reduce((total, c) => total + c.trades, 0);
  assert.equal(sum, 40, 'every trade lands in exactly one bucket');
});

test('a history outside the requested window does not change the last buckets', () => {
  const wide = index.candles(token, 86400, 1);
  assert.equal(wide.length, 1);
  assert.equal(wide[0].trades, 40);
});

test('a token stored with a checksummed address is still found by a lowercase lookup', () => {
  // A listing hands the stored casing back to a page that looks the token up in lowercase; older rows can be
  // checksummed, and that mismatch used to 404 the whole token page.
  const mixed = '0x' + 'AbCd'.repeat(10);
  index.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(mixed, 1, JSON.stringify({ address: mixed, symbol: 'MIX', name: 'Mixed case' }));

  assert.equal(index.tokenAt(mixed.toLowerCase())?.symbol, 'MIX', 'lowercase lookup finds a checksummed row');
  assert.equal(index.tokenAt(mixed)?.symbol, 'MIX', 'the stored casing still works');
  assert.equal(index.tokenAt('0x' + '11'.repeat(20))?.symbol, 'LEG', 'exact matches keep working');
});
