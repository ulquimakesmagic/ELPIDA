// The live trade feed: bounded connections, trimmed payloads, and a client that reconnects instead of hammering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeFeed } from '../apps/api/trade-feed.mjs';
import { connectTradeStream, mergeTrades } from '../apps/web/live-trades.mjs';

/** A response stand-in that records what was written. */
function fakeResponse() {
  const listeners = {};
  return {
    headers: null, written: '', ended: false, destroyed: false, writableLength: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.written += chunk; return true; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
    on(event, fn) { (listeners[event] ??= []).push(fn); },
    emit(event) { for (const fn of listeners[event] ?? []) fn(); },
  };
}

const trade = (n, overrides = {}) => ({
  address: '0x' + '11'.repeat(20), network: 'base-sepolia', symbol: 'HOPE', name: 'Hope',
  side: 'buy', priceQuote: '1.5', quoteSymbol: 'ETH', timestamp: 1700000000 + n,
  tx: '0x' + n.toString(16).padStart(64, '0'), height: 100 + n, extra: 'not sent',
  ...overrides,
});

test('a subscriber gets an event-stream with a ready frame and no caching', () => {
  const feed = new TradeFeed();
  const res = fakeResponse();
  const opened = feed.subscribe({ res, address: '1.2.3.4' });

  assert.equal(opened.ok, true);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.match(res.headers['Cache-Control'], /no-transform/);
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.match(res.written, /^retry: 3000\n\n/);
  assert.match(res.written, /event: ready/);
});

test('published trades are trimmed to the fields the strip renders', () => {
  const feed = new TradeFeed();
  const res = fakeResponse();
  feed.subscribe({ res, address: 'a' });
  const sent = feed.publish('base-sepolia', [trade(1)]);

  assert.equal(sent, 1);
  const frame = res.written.split('event: trades\ndata: ')[1];
  const payload = JSON.parse(frame.split('\n\n')[0]);
  assert.equal(payload.network, 'base-sepolia');
  assert.equal(payload.trades.length, 1);
  assert.equal(payload.trades[0].symbol, 'HOPE');
  assert.equal('extra' in payload.trades[0], false, 'unlisted fields are not sent');
});

test('a batch is capped and nothing is published without subscribers', () => {
  const feed = new TradeFeed();
  assert.equal(feed.publish('base-sepolia', [trade(1)]), 0, 'no clients, no work');

  const res = fakeResponse();
  feed.subscribe({ res, address: 'a' });
  const many = Array.from({ length: 50 }, (_, i) => trade(i));
  feed.publish('base-sepolia', many);
  const payload = JSON.parse(res.written.split('event: trades\ndata: ')[1].split('\n\n')[0]);
  assert.equal(payload.trades.length, 20, 'a batch never grows past twenty');
});

test('connections are bounded per address and in total', () => {
  const feed = new TradeFeed({ maxPerAddress: 2, maxClients: 3 });
  assert.equal(feed.subscribe({ res: fakeResponse(), address: 'a' }).ok, true);
  assert.equal(feed.subscribe({ res: fakeResponse(), address: 'a' }).ok, true);
  const third = feed.subscribe({ res: fakeResponse(), address: 'a' });
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);

  assert.equal(feed.subscribe({ res: fakeResponse(), address: 'b' }).ok, true);
  const full = feed.subscribe({ res: fakeResponse(), address: 'c' });
  assert.equal(full.ok, false);
  assert.equal(full.status, 503);
});

test('closing a connection frees its slot', () => {
  const feed = new TradeFeed({ maxPerAddress: 1 });
  const res = fakeResponse();
  feed.subscribe({ res, address: 'a' });
  assert.equal(feed.subscribe({ res: fakeResponse(), address: 'a' }).ok, false);
  res.emit('close');
  assert.equal(feed.subscribe({ res: fakeResponse(), address: 'a' }).ok, true);
  assert.equal(feed.status().clients, 1);
});

test('a client that stops reading is dropped instead of buffered', () => {
  const feed = new TradeFeed();
  const stuck = fakeResponse();
  stuck.writableLength = TradeFeed.MAX_BUFFERED + 1;
  feed.subscribe({ res: stuck, address: 'a' });
  const healthy = fakeResponse();
  feed.subscribe({ res: healthy, address: 'b' });

  feed.publish('base-sepolia', [trade(1)]);

  assert.equal(stuck.destroyed, true);
  assert.equal(feed.status().clients, 1, 'the healthy client stays');
  assert.equal(feed.status().dropped, 1);
  assert.match(healthy.written, /event: trades/);
});

test('closing the feed ends every stream', () => {
  const feed = new TradeFeed();
  const a = fakeResponse(), b = fakeResponse();
  feed.subscribe({ res: a, address: 'a' });
  feed.subscribe({ res: b, address: 'b' });
  feed.close();
  assert.equal(a.ended && b.ended, true);
  assert.equal(feed.status().clients, 0);
});

/** An EventSource stand-in that lets a test fire the events a browser would. */
function fakeSourceClass() {
  const created = [];
  class FakeSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; created.push(this); }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    close() { this.closed = true; }
    fire(name, data) { for (const fn of this.listeners[name] ?? []) fn({ data }); }
  }
  return { FakeSource, created };
}

test('the connector reports trades and ignores a malformed frame', () => {
  const { FakeSource, created } = fakeSourceClass();
  const got = [];
  let opened = 0;
  const stream = connectTradeStream({ EventSourceImpl: FakeSource, onTrades: trades => got.push(...trades), onOpen: () => { opened++; } });

  created[0].fire('ready');
  created[0].fire('trades', JSON.stringify({ network: 'base-sepolia', trades: [trade(1), trade(2)] }));
  assert.doesNotThrow(() => created[0].fire('trades', '{not json'));
  created[0].fire('trades', JSON.stringify({ trades: [] }));

  assert.equal(opened, 1);
  assert.equal(got.length, 2);
  assert.equal(stream.open, true);
  stream.close();
});

test('an error closes the stream and retries with a growing delay', () => {
  const { FakeSource, created } = fakeSourceClass();
  const delays = [];
  const scheduled = [];
  const stream = connectTradeStream({
    EventSourceImpl: FakeSource,
    schedule: (fn, delay) => { delays.push(delay); scheduled.push(fn); return scheduled.length; },
    cancel: () => {},
    minDelay: 1000,
    maxDelay: 4000,
  });

  created[0].fire('error');
  assert.equal(created[0].closed, true, 'the dead connection is closed');
  assert.equal(stream.open, false);

  scheduled.shift()(); // first retry
  created[1].fire('error');
  scheduled.shift()(); // second retry
  created[2].fire('error');

  assert.deepEqual(delays, [1000, 2000, 4000], 'the delay doubles and stops at the ceiling');
  stream.close();
});

test('close stops further retries', () => {
  const { FakeSource, created } = fakeSourceClass();
  const scheduled = [];
  const stream = connectTradeStream({ EventSourceImpl: FakeSource, schedule: fn => { scheduled.push(fn); return scheduled.length; }, cancel: () => {} });

  created[0].fire('error');
  const retry = scheduled.shift();
  stream.close();
  retry();
  assert.equal(created.length, 1, 'no connection is opened after close');
});

test('a browser without EventSource degrades to polling', () => {
  const stream = connectTradeStream({ EventSourceImpl: undefined, schedule: () => 0 });
  assert.equal(stream.supported, false);
  assert.equal(stream.open, false);
  stream.close();
});

test('streamed trades merge without duplicates and stay newest first', () => {
  const first = mergeTrades([], [trade(3), trade(1)]);
  assert.deepEqual(first.trades.map(t => t.height), [103, 101]);
  assert.equal(first.added, 2);

  // The poll already showed 101; the stream repeats it alongside a new one.
  const second = mergeTrades(first.trades, [trade(1), trade(4)]);
  assert.deepEqual(second.trades.map(t => t.height), [104, 103, 101]);
  assert.equal(second.added, 1, 'the repeat is not counted again');

  const repeated = mergeTrades(second.trades, [trade(4)]);
  assert.equal(repeated.added, 0, 'a duplicate alone changes nothing');
  assert.equal(repeated.trades.length, 3);
});

test('the list stays capped and ignores junk', () => {
  let trades = [];
  for (let i = 0; i < 30; i++) trades = mergeTrades(trades, [trade(i)]).trades;
  assert.equal(trades.length, 20, 'never more than the strip shows');
  assert.equal(trades[0].height, 129, 'newest first');

  const cleaned = mergeTrades(trades, [null, {}, { tx: '0x1' }]);
  assert.equal(cleaned.added, 1, 'only the entry with a transaction hash is added');
  assert.equal(mergeTrades([], undefined).added, 0);
});

test('index rows from both chains become feed trades the browser can merge (hash, log index, amounts), unknown tokens dropped', async () => {
  const { feedTrades } = await import('../apps/api/public-indexer.mjs');
  const listings = [{ address: '0xAbC', name: 'Evm Token', symbol: 'EVM', quoteSymbol: 'ETH', metadata: {} }, { address: 'So1Mint', name: 'Sol Token', symbol: 'SOLT', quoteSymbol: 'SOL', metadata: { image: 'https://x/i.png' } }];
  const evm = { hash: '0xh', index: 3, token: '0xabc', side: 'buy', account: '0xacc', quoteAmount: '0.1', tokenAmount: '1000', priceQuote: '0.0001', timestamp: 50, blockNumber: 77, venue: 'curve' };
  const sol = { hash: 'sig', idx: 1, token: 'So1Mint', side: 'sell', account: 'Wallet', quoteAmount: '0.2', tokenAmount: '5', priceQuote: 0.04, timestamp: 60, slot: 900, launch: false };
  const out = feedTrades('mixed', [evm, sol, { hash: 'x', token: 'unknown' }, { token: '0xabc' }], listings);
  assert.equal(out.length, 2, 'unknown tokens and rows without a hash are dropped');
  assert.deepEqual([out[0].tx, out[0].index, out[0].height, out[0].address, out[0].quoteSymbol, out[0].quoteAmount], ['0xh', 3, 77, '0xAbC', 'ETH', '0.1']);
  assert.deepEqual([out[1].tx, out[1].index, out[1].height, out[1].image, out[1].symbol], ['sig', 1, 900, 'https://x/i.png', 'SOLT']);
  // Two trades in one transaction are both kept by the browser merge.
  const merged = mergeTrades([], [{ ...out[1], index: 0 }, out[1]]);
  assert.equal(merged.added, 2);
});
