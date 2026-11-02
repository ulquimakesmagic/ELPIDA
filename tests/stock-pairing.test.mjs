// Tokenized-stock pairing: how each stock is represented in the launch picker (packages/core/stock-catalog.mjs), and
// the reference-feed observation the Ethereum fork rehearsal records for TSLAon and SPYon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { stockIdentity, looksLikeStock, catalogMap, searchStocks, STOCK_UNDERLYINGS, STOCK_LOGOS } from '../packages/core/stock-catalog.mjs';
import { parseCatalog, createStockCatalog, CATALOG_URL, ICON_BASE } from '../apps/api/stock-catalog.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVM_TEST_PAIRS } from '../packages/core/pairs.mjs';
import { observeReferenceFeeds } from '../scripts/equity-lifecycle-fork.mjs';
import { compileContracts } from '../scripts/compile.mjs';

test('each stock reads as its company, its type and its issuer; test stand-ins are marked', () => {
  assert.deepEqual((({ ticker, company, type, issuer, test }) => ({ ticker, company, type, issuer, test }))(stockIdentity('TSLAon')),
    { ticker: 'TSLA', company: 'Tesla, Inc.', type: 'Stock', issuer: 'Ondo', test: false });
  assert.equal(stockIdentity('SPYon').type, 'ETF');
  assert.equal(stockIdentity('QQQon').company, 'Invesco QQQ Trust');
  assert.deepEqual((({ ticker, issuer, test }) => ({ ticker, issuer, test }))(stockIdentity('tNVDAon', { provider: 'ondo-test' })), { ticker: 'NVDA', issuer: 'Ondo (test)', test: true });
  assert.equal(stockIdentity('TSLAx').issuer, 'xStocks');
  assert.equal(stockIdentity('TEST-STOCK').test, true);
  assert.equal(stockIdentity('ZZZZ', { name: 'Unknown Co' }).company, 'Unknown Co', 'unknown tickers keep their own name');
  assert.ok(looksLikeStock('SPYon') && looksLikeStock('tNVDAon') && !looksLikeStock('USDC') && !looksLikeStock('Hope'));
});

test('stocks shown together never share a colour, and no logo is shown unless one was supplied', () => {
  for (const group of [['TSLA', 'SPY', 'NVDA', 'QQQ'], ['AAPL', 'TSLA', 'NVDA', 'SPY', 'QQQ']]) {
    const tones = group.map(t => STOCK_UNDERLYINGS[t].tone);
    assert.equal(new Set(tones).size, tones.length, group.join(','));
  }
  assert.equal(stockIdentity('TSLAon').logo, '/api/public/stock-icon/TSLAon.png', "Ondo stocks use Ondo's own icon");
  assert.equal(stockIdentity('tNVDAon', { provider: 'ondo-test' }).logo, '/api/public/stock-icon/NVDAon.png', 'a stand-in shows the stock it imitates (with a Test badge)');
  assert.equal(stockIdentity('TSLAx').logo, STOCK_LOGOS.has('TSLA') ? '/assets/stocks/TSLA.png' : null, 'no issuer icon, no supplied logo: a ticker tile');
});

test('Ondo catalog names win over the short list; search finds by ticker, symbol or company', () => {
  const catalog = catalogMap({ assets: [{ symbol: 'TSLAon', ticker: 'TSLA', name: 'Tesla', type: 'Stock' }, { symbol: 'IBITon', ticker: 'IBIT', name: 'iShares Bitcoin Trust ETF', type: 'ETF' }] });
  assert.equal(stockIdentity('IBITon', { catalog }).company, 'iShares Bitcoin Trust ETF');
  assert.equal(stockIdentity('IBITon', { catalog }).type, 'ETF');
  assert.equal(stockIdentity('tTSLAon', { catalog }).company, 'Tesla', 'a stand-in borrows the real stock’s name');
  const items = ['TSLAon', 'tTSLAon', 'SPYon', 'AAPLon', 'IBITon'].map(symbol => ({ symbol, ticker: stockIdentity(symbol).ticker, company: stockIdentity(symbol, { catalog }).company }));
  assert.deepEqual(searchStocks(items, 'tsla').map(i => i.symbol), ['TSLAon', 'tTSLAon']);
  assert.deepEqual(searchStocks(items, 'bitcoin').map(i => i.symbol), ['IBITon']);
  assert.deepEqual(searchStocks(items, 'apple').map(i => i.symbol), ['AAPLon']);
  assert.equal(searchStocks(items, '').length, 5);
});

test('every stock the launchpad can pair with today has a company name in the picker', () => {
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const symbols = [...EVM_TEST_PAIRS.filter(p => p.kind === 'xstock').map(p => p.symbol), ...registry.assets.filter(a => a.provider === 'ondo').map(a => a.symbol)];
  for (const s of new Set(symbols)) assert.ok(stockIdentity(s).company, `${s} has no company name`);
});

test('fork rehearsal: candidate reference feeds are read at the fork block, with age, heartbeat and spread', async t => {
  const connection = await network.create('localTest'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  t.after(async () => { provider.destroy(); await connection.close(); });
  const art = compileContracts({ includeMocks: true })['tests/fixtures/MockUsdFeed.sol'].MockUsdFeed, signer = await provider.getSigner(0);
  const deploy = async price => { const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy(price); await c.waitForDeployment(); return c; };
  const a = await deploy(401_59000000n), b = await deploy(402_00000000n);
  const now = Number((await provider.getBlock('latest')).timestamp);
  const evidence = { network: 'ethereum', assets: [{ symbol: 'TSLAon', candidates: [{ name: 'API', proxy: a.target, heartbeatSec: 86400 }, { name: 'Calculated', proxy: b.target, heartbeatSec: 86400 }, { name: 'missing', proxy: '0x' + '9'.repeat(40), heartbeatSec: 86400 }] }] };
  const feeds = await observeReferenceFeeds({ provider, network: 'ethereum', symbol: 'TSLAon', blockTimestamp: now, evidence });
  assert.equal(feeds.length, 3);
  assert.deepEqual(feeds.slice(0, 2).map(f => [f.price, f.decimals, f.fresh, f.approved]), [['401.5900', 8, true, false], ['402.0000', 8, true, false]]);
  assert.equal(feeds[0].candidateSpreadPct, 0.1021, 'the two variants differ by about 0.1%');
  assert.ok(feeds[2].error, 'an unreadable candidate is recorded, not fatal');
  assert.deepEqual(await observeReferenceFeeds({ provider, network: 'bnb', symbol: 'TSLAon', blockTimestamp: now, evidence }), [], 'no candidates recorded for BNB');
});

const ondoAsset = (symbol, ticker, assetName, tag = 'stock', extra = {}) => ({ symbol, ticker, assetName, iconSrc: `https://cdn.ondo.finance/tokens/logos/${symbol.toLowerCase()}_160x160.png`, tags: [{ categorySlug: 'instrument-type', tagSlug: tag, tagLabel: tag }], isTradingPaused: false, ...extra });
const bigCatalog = () => ({ lastUpdatedAt: '2026-11-02T16:14:36Z', assets: [
  ondoAsset('TSLAon', 'TSLA', 'Tesla'), ondoAsset('SPYon', 'SPY', 'SPDR S&P 500 ETF', 'etf'), ondoAsset('USDY', 'USDY', 'Ondo US Dollar Yield'),
  ondoAsset('BADon<', 'X', 'bad'), ondoAsset('NAMEon', 'NAME', '<script>x</script> Corp'),
  ...Array.from({ length: 60 }, (_, i) => ondoAsset(`S${i}on`, `S${i}`, `Stock ${i}`)),
] });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const respond = (body, { status = 200, type = 'application/json' } = {}) => new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

test('catalog: only well-formed Ondo stock records, cleaned; non-stocks and malformed symbols dropped; too small rejected', () => {
  const assets = parseCatalog(bigCatalog());
  assert.ok(assets.some(a => a.symbol === 'TSLAon' && a.type === 'Stock' && a.name === 'Tesla'));
  assert.equal(assets.find(a => a.symbol === 'SPYon').type, 'ETF');
  assert.ok(!assets.some(a => a.symbol === 'USDY' || a.symbol.includes('<')), 'not a stock, or a bad symbol');
  assert.equal(assets.find(a => a.symbol === 'NAMEon').name, 'scriptx/script Corp', 'markup characters stripped');
  assert.throws(() => parseCatalog({ assets: [ondoAsset('TSLAon', 'TSLA', 'Tesla')] }), /too small/);
  assert.throws(() => parseCatalog({ nope: [] }), /unexpected/);
});

test('catalog service: refreshes from Ondo, caches on disk; icons only for listed stocks, only PNGs from Ondo\'s CDN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stock-cat-')), calls = [];
  let iconBody = png, iconType = 'image/png';
  const fetchImpl = async (url, opts) => {
    calls.push(url); assert.equal(opts.redirect, 'error', 'redirects are refused');
    if (url === CATALOG_URL) return respond(bigCatalog());
    if (url.startsWith(ICON_BASE)) return respond(iconBody, { type: iconType });
    throw new Error('unexpected host ' + url);
  };
  const cat = createStockCatalog({ dataDir: dir, fetchImpl, autoRefresh: false });
  assert.equal(cat.summary().count, 0);
  await cat.refresh();
  assert.ok(cat.summary().count >= 60 && cat.summary().fetchedAt);
  assert.equal(await cat.icon('ZZZZon'), null, 'not in the catalog: never fetched');
  assert.ok(!calls.some(u => u.includes('zzzzon')));
  assert.deepEqual(await cat.icon('TSLAon'), png);
  assert.ok(calls.includes(`${ICON_BASE}tslaon_160x160.png`));
  const before = calls.length; assert.deepEqual(await cat.icon('TSLAon'), png); assert.equal(calls.length, before, 'served from the disk cache');
  iconBody = '<svg/>'; iconType = 'image/svg+xml';
  assert.equal(await cat.icon('SPYon'), null, 'anything but a PNG is refused');
  // A restart reads the cached catalog without fetching.
  const again = createStockCatalog({ dataDir: dir, fetchImpl: async () => { throw new Error('offline'); }, autoRefresh: false });
  assert.equal(again.summary().count, cat.summary().count);
  await again.refresh();
  assert.equal(again.summary().count, cat.summary().count, 'a failed refresh keeps the last good catalog');
});

test('API: the catalog and icons are served from this origin; unknown symbols 404', async t => {
  const { startServer } = await import('../apps/api/server.mjs');
  const fake = { summary: () => ({ provider: 'ondo', count: 1, assets: [{ symbol: 'TSLAon', ticker: 'TSLA', name: 'Tesla', type: 'Stock' }] }), icon: async s => s === 'TSLAon' ? png : null, close() {} };
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app', stockCatalog: fake });
  t.after(() => app.close());
  const catalog = await fetch(`${app.url}/api/public/stock-catalog`);
  assert.equal(catalog.status, 200); assert.equal((await catalog.json()).assets[0].name, 'Tesla');
  const icon = await fetch(`${app.url}/api/public/stock-icon/TSLAon.png`);
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await icon.arrayBuffer()), png);
  assert.equal((await fetch(`${app.url}/api/public/stock-icon/SPYon.png`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/public/stock-icon/..%2Fsecret.png`)).status, 404);
  assert.equal((await fetch(`${app.url}/stock-catalog.mjs`)).status, 200, 'the browser module is served');
  assert.equal((await fetch(`${app.url}/stock-picker.mjs`)).status, 200, 'the dropdown module is served');
  // Every module a page imports must be served, or the page fails to load (a new module needs an entry in server.mjs).
  const { readdirSync } = await import('node:fs');
  const web = new URL('../apps/web/', import.meta.url), wanted = new Set();
  for (const file of readdirSync(web).filter(f => f.endsWith('.mjs'))) {
    const src = readFileSync(new URL(file, web), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/|\/)([a-z0-9-]+\.mjs)['"]/g)) if (!m[2].startsWith('vendor')) wanted.add('/' + m[2]);
  }
  const missing = [];
  for (const path of wanted) if ((await fetch(`${app.url}${path}`)).status !== 200) missing.push(path);
  assert.deepEqual(missing, [], 'imported by apps/web but not served');
});
