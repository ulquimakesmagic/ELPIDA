// The stream over a real socket: headers a proxy will honour, a ready frame, and a published trade arriving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../apps/api/server.mjs';

const trade = {
  address: '0x' + '11'.repeat(20), network: 'base-sepolia', symbol: 'HOPE', name: 'Hope',
  side: 'buy', priceQuote: '1.5', quoteSymbol: 'ETH', timestamp: 1700000000,
  tx: '0x' + 'ab'.repeat(32), height: 101,
};

/** Reads the stream until `needle` appears, then aborts. */
async function readUntil(url, needle, controller) {
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { response, text };
}

test('the public stream is an event stream a proxy will not buffer or cache', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const controller = new AbortController();
  t.after(() => controller.abort());

  const { response, text } = await readUntil(`${app.url}/api/public/stream`, 'event: ready', controller);

  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('cache-control'), /no-transform/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(text, /^retry: 3000/);
});

test('a trade published by the server reaches an open stream', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const controller = new AbortController();
  t.after(() => controller.abort());

  const reader = await fetch(`${app.url}/api/public/stream`, { signal: controller.signal });
  const body = reader.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) text += decoder.decode((await body.read()).value, { stream: true });

  app.tradeFeed.publish('base-sepolia', [trade]);

  const deadline = Date.now() + 5000;
  while (!text.includes('event: trades') && Date.now() < deadline) {
    text += decoder.decode((await body.read()).value, { stream: true });
  }

  assert.match(text, /event: trades/);
  const payload = JSON.parse(text.split('event: trades\ndata: ')[1].split('\n\n')[0]);
  assert.equal(payload.network, 'base-sepolia');
  assert.equal(payload.trades[0].symbol, 'HOPE');
  assert.equal(payload.trades[0].side, 'buy');
});

test('the stream is protected like the rest of the API', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const controller = new AbortController();
  t.after(() => controller.abort());

  const response = await fetch(`${app.url}/api/public/stream`, { signal: controller.signal });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(String(response.headers.get('x-robots-tag')), /noindex/);
  assert.match(String(response.headers.get('content-security-policy')), /connect-src 'self'/);
});

test('closing the server ends open streams instead of waiting for them', async () => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  const controller = new AbortController();
  const response = await fetch(`${app.url}/api/public/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();

  await app.close(); // would hang on an open connection if the feed were not closed first
  controller.abort();
});

test('the browser can fetch the module that opens the stream', async t => {
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());

  // Only files listed in the server's resource map are served; a missing entry would 404 the app's own import.
  const module = await fetch(`${app.url}/live-trades.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.match(await module.text(), /export function connectTradeStream/);

  const appModule = await fetch(`${app.url}/app.mjs`);
  assert.match(await appModule.text(), /from '\.\/live-trades\.mjs'/, 'the app imports it by the served path');
});
