// Coinbase Tokenized Stocks (Base): names and icons from Coinbase's public API, served from this origin (20 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoinbaseStocks, coinbaseSymbol, createCoinbaseStocks, COINBASE_STOCKS_URL } from '../apps/api/coinbase-stocks.mjs';
import { stockIdentity } from '../packages/core/stock-catalog.mjs';
import { PAIR_INFO } from '../packages/core/pairs.mjs';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80)]);
const page = { tokens: [
  { symbol: 'AAPLc', contract_address: '0xb200000000000000000000C2e324d24d7eEcd1fb', name: 'Apple Inc.', icon_url: 'https://assets.coinbase.com/aapl.png' },
  { symbol: 'NVDA', contract_address: '0xb200000000000000000000000000000000000108', name: 'NVIDIA <b>', icon_url: 'http://insecure.example/x.png' },
  { symbol: 'bad', contract_address: 'nope' },
] };

test('parse: symbols normalised to AAPLc, https icons only, bad rows dropped', () => {
  assert.equal(coinbaseSymbol('AAPLC'), 'AAPLc'); assert.equal(coinbaseSymbol('NVDA'), 'NVDAc'); assert.equal(coinbaseSymbol(''), null);
  const { tokens, next } = parseCoinbaseStocks(page);
  assert.equal(next, null);
  assert.deepEqual(tokens.map(t => t.symbol), ['AAPLc', 'NVDAc', 'BADc'].slice(0, 2));
  assert.equal(tokens[0].icon, 'https://assets.coinbase.com/aapl.png'); assert.equal(tokens[1].icon, null);
  assert.equal(tokens[1].name, 'NVIDIA b');
});

test('icons: fetched once, image types only; the API is read with pagination', async () => {
  let calls = [];
  const fetchImpl = async url => { calls.push(url);
    if (url.startsWith(COINBASE_STOCKS_URL)) return new Response(JSON.stringify(page), { status: 200 });
    if (url === 'https://assets.coinbase.com/aapl.png') return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('x', { status: 404 }); };
  const cb = createCoinbaseStocks({ fetchImpl, autoRefresh: false });
  await cb.refresh();
  assert.match(calls[0], /\?page_size=500$/);
  assert.equal(cb.summary().tokens.length, 2);
  const a = await cb.icon('AAPLc'), b = await cb.icon('AAPLc');
  assert.equal(a.type, 'image/png'); assert.equal(a, b); assert.equal(calls.filter(u => u.endsWith('aapl.png')).length, 1);
  assert.equal(await cb.icon('NVDAc'), null);
  assert.equal(await cb.icon('ZZZc'), null);
});

test('Coinbase stocks get their icon in the pickers; pair cards are brief', () => {
  const id = stockIdentity('AAPLc', { name: 'Apple (Coinbase)' });
  assert.equal(id.issuer, 'Coinbase'); assert.equal(id.ticker, 'AAPL'); assert.equal(id.logo, '/api/public/coinbase-stock-icon/AAPLc.png');
  assert.equal(stockIdentity('AAPLc').issuer, null, 'a bare c-suffix is not assumed to be Coinbase');
  assert.equal(PAIR_INFO.xstock.note(), 'Buyers pay in a tokenized stock. Choose it below.');
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /coinbase-stock-icon/); assert.ok(server.includes("'/api/public/coinbase-stocks'"));
  const flow = readFileSync(new URL('../apps/web/launch-flow.mjs', import.meta.url), 'utf8');
  assert.match(flow, /control: stockPicker\(\{ assets: publicRewardAssets\(\)/);
  assert.match(flow, /vq = curve\.v2vq \?\? curve\.vq \* 1\.125/);
});

test('icons: type read from the bytes (Coinbase CDN may say octet-stream); Ondo fallback wired', async () => {
  const { sniffImage, createCoinbaseStocks } = await import('../apps/api/coinbase-stocks.mjs');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)]);
  assert.equal(sniffImage(png), 'image/png'); assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  const fetchImpl = async url => url.includes('tokenized-stocks')
    ? new Response(JSON.stringify({ tokens: [{ symbol: 'AAPLc', contract_address: '0x' + '1'.repeat(40), name: 'Apple Inc.', icon_url: 'https://metadata.coinbase.com/equity_icons/a.png' }] }))
    : new Response(png, { headers: { 'content-type': 'binary/octet-stream' } });
  const cb = createCoinbaseStocks({ fetchImpl, autoRefresh: false }); await cb.refresh();
  const img = await cb.icon('AAPLc'); assert.equal(img.type, 'image/png'); assert.equal(img.bytes.length, png.length);
  const server = readFileSync(new URL('../apps/api/server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('stockCatalog.icon(`${m[1].slice(0,-1)}on`)'), 'falls back to the Ondo icon for the same company');
});
