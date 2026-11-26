// The public read API for builders (apps/api/public-api-v1.mjs, 26 Nov 2026): stable GET endpoints under /api/v1, open
// to any origin, rate limited per client, mainnet V2 launches only, and the published ABIs match the contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { publicApiV1, API_V1_PER_MINUTE } from '../apps/api/public-api-v1.mjs';
import { PUBLIC_ABIS } from '../packages/core/public-abi.mjs';

const origin = 'https://elpida.fun';
const rh = { key: 'robinhood-mainnet', chainId: 4663, name: 'Robinhood Chain', mainnet: true, kind: 'evm', explorer: 'https://robinhoodchain.blockscout.com', nativeCurrency: { symbol: 'ETH' }, payoutStable: { symbol: 'USDG' },
  v4: { poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
  v2: { shared: { model: 'v2.3-hook', factory: '0x29f0d2a8f2dd5b2df872222f10be35d6b27afd71', hook: '0x87e7c9477ffe0347d729c7d574964e72ea76a8cc', router: '0xc3c730efade65f72b677e877d2accb8c5a697960', treasury: '0x' + '7'.repeat(40) } } };
const testnet = { key: 'base-sepolia', chainId: 84532, name: 'Base Sepolia', mainnet: false, kind: 'evm', v2: { shared: { factory: '0x' + '1'.repeat(40) } } };
const pepe = { address: '0x7281b88cb52e45a2b9089ac06768c19efde4b4b5', name: 'pepe', symbol: 'PEPE', creator: '0x9d92cd8e26c0b6f3da282182b12132d2c86cb29b', created: 1_795_651_998_000, deploymentModel: 'v2-hook', metadata: { image: '/api/content/bafy', twitter: 'https://x.com/pepe' }, metadataURI: 'ipfs://bafy' };

function harness(extra = {}) {
  let t = 1_000_000;
  const index = {
    listings: k => (k === 'robinhood-mainnet' ? [pepe] : []),
    listing: (k, a) => (k === 'robinhood-mainnet' && a === pepe.address ? pepe : null),
    freshness: () => ({ indexedAt: '2026-11-26T00:00:00Z', stale: false }),
    detail: (k, a, kind, interval) => (kind === 'trades' ? [{ side: 'buy' }] : kind === 'candles' ? [{ t: 0, interval }] : [{ holder: '0x1' }]),
  };
  const handle = publicApiV1({ networks: () => [rh, testnet], index, origin: () => origin, ewpr: w => ({ rules: 'ewpr-1', wallet: w }), clientIp: req => req.ip ?? '1.1.1.1', now: () => t, ...extra });
  const call = async (path, { method = 'GET', ip } = {}) => {
    const headers = {}; let status = null, body = null;
    const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, writeHead: s => { status = s; }, end: () => {} };
    const handled = await handle({ method, ip }, res, new URL(path, 'http://local'), (s, b) => { status = s; body = b; });
    return { handled, status, body, headers };
  };
  return { call, tick: ms => { t += ms; } };
}

test('index, chains and ABIs: what a builder needs to start', async () => {
  const { call } = harness();
  const idx = await call('/api/v1');
  assert.equal(idx.status, 200); assert.equal(idx.headers['access-control-allow-origin'], '*');
  assert.equal(idx.body.docs, `${origin}/#/docs/developers`); assert.ok(idx.body.endpoints.some(e => e.route.startsWith('GET /api/v1/tokens')));
  const chains = (await call('/api/v1/chains')).body.chains;
  assert.deepEqual(chains.map(c => c.chain), ['robinhood-mainnet'], 'test networks never appear');
  assert.deepEqual(chains[0].contracts, { factory: '0x29f0D2A8F2DD5B2dF872222f10bE35D6B27aFD71', hook: '0x87e7C9477ffe0347d729c7D574964e72Ea76A8cc', router: '0xC3C730EFade65F72B677E877d2ACcb8C5a697960', treasury: '0x7777777777777777777777777777777777777777', poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' });
  assert.deepEqual(chains[0].feeSplitBps, { traders: 5000, creator: 3000, elpida: 2000 }); assert.equal(chains[0].payoutToken, 'USDG');
  const router = (await call('/api/v1/abi/router')).body;
  assert.ok(router.some(f => f.type === 'function' && f.name === 'buy')); assert.ok(router.some(f => f.type === 'event' && f.name === 'Swapped'));
  assert.equal((await call('/api/v1/abi/nope')).status, 404);
});

test('tokens: the list, one token and its trades, candles and holders', async () => {
  const { call } = harness();
  const list = (await call('/api/v1/tokens')).body;
  assert.equal(list.count, 1); assert.equal(list.tokens[0].symbol, 'PEPE'); assert.equal(list.tokens[0].chain, 'robinhood-mainnet'); assert.equal(list.tokens[0].image, `${origin}/api/content/bafy`);
  assert.equal((await call('/api/v1/tokens?chain=base-sepolia')).status, 400, 'a test network is not a chain of the API');
  const one = (await call(`/api/v1/tokens/robinhood-mainnet/${pepe.address}`)).body;
  assert.equal(one.address, '0x7281B88cB52E45a2b9089AC06768c19EfdE4b4B5'); assert.equal(one.stale, false); assert.equal(one.metadataURI, 'ipfs://bafy');
  assert.deepEqual((await call(`/api/v1/tokens/robinhood-mainnet/${pepe.address}/trades`)).body.trades, [{ side: 'buy' }]);
  assert.equal((await call(`/api/v1/tokens/robinhood-mainnet/${pepe.address}/candles?interval=300`)).body.candles[0].interval, 300);
  assert.equal((await call(`/api/v1/tokens/robinhood-mainnet/${pepe.address}/candles?interval=7`)).status, 400);
  assert.equal((await call(`/api/v1/tokens/robinhood-mainnet/0x${'e'.repeat(40)}`)).status, 404);
});

test('read-only, rate limited per client, and other paths are left alone', async () => {
  const { call, tick } = harness();
  assert.equal((await call('/api/v1/tokens', { method: 'POST' })).status, 405);
  assert.equal((await call('/api/v1', { method: 'OPTIONS' })).status, 204);
  assert.equal((await call('/api/public/status')).handled, false);
  for (let i = 0; i < API_V1_PER_MINUTE; i++) await call('/api/v1', { ip: '9.9.9.9' });
  const over = await call('/api/v1', { ip: '9.9.9.9' });
  assert.equal(over.status, 429); assert.ok(Number(over.headers['retry-after']) > 0);
  assert.equal((await call('/api/v1', { ip: '8.8.8.8' })).status, 200, 'another client is not affected');
  tick(60_000); assert.equal((await call('/api/v1', { ip: '9.9.9.9' })).status, 200, 'the window resets after a minute');
  assert.equal((await call('/api/v1/rewards?wallet=bad')).status, 400);
  assert.equal((await call(`/api/v1/rewards?wallet=0x${'a'.repeat(40)}`)).body.rules, 'ewpr-1');
});

test('the published ABIs match the contracts they describe', () => {
  const src = f => readFileSync(new URL(`../contracts/evm/${f}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const factory = src('v2/ElpidaV2Factory.sol'), hook = src('v2/ElpidaV23Hook.sol'), router = src('v4/ElpidaV4Router.sol');
  for (const [abi, code] of [[PUBLIC_ABIS.factory, factory], [PUBLIC_ABIS.hook, hook], [PUBLIC_ABIS.router, router]]) {
    for (const frag of new Interface(abi).fragments) {
      if (frag.type === 'event') assert.match(code, new RegExp(`event ${frag.name}\\(`), `${frag.name} event exists`);
      if (frag.type === 'function' && !['launchFee', 'hook', 'treasury', 'approvedQuotes', 'tokenMetadataURI', 'poolManager', 'factory'].includes(frag.name)) assert.match(code, new RegExp(`function ${frag.name}\\(`), `${frag.name} exists`);
    }
  }
  assert.match(hook, /function launchOf\(address token\) external view returns \(address quote, address creatorVault, uint64 launchedAt, uint16 feeBps, bool graduated, int24 upperTick, int24 lowerTick, uint128 liquidityBonus, uint128 accrued\)/);
});

test('the server answers /api/v1 and keeps its other routes', async t => {
  const { startServer } = await import('../apps/api/server.mjs');
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const r = await fetch(`${app.url}/api/v1`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal((await r.json()).version, 1);
  assert.equal((await fetch(`${app.url}/api/v1/chains`)).status, 200);
  assert.equal((await fetch(`${app.url}/health`)).status, 200);
});

test('the docs carry a Developers section and the footer links to it', () => {
  const docs = readFileSync(new URL('../apps/web/docs-view.mjs', import.meta.url), 'utf8'), html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(docs, /\['developers', 'Developers', 'code'\]/);
  for (const route of ['/api/v1/chains', '/api/v1/tokens', '/api/v1/rewards', '/api/v1/abi']) assert.ok(docs.includes(`'${route}`), route);
  assert.match(html, /href="#\/docs\/developers"/);
  assert.match(readFileSync(new URL('../apps/web/assets/icons.svg', import.meta.url), 'utf8'), /id="i-code"/);
});
