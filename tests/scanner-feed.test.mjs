// The launch feed for scanners (apps/api/scanner-feed.mjs, 22 Nov 2026): mainnet V2 launches only, newest first, with
// absolute image and link URLs, chain facts and the pool, paged by since/limit; test networks never appear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerFeed, scannerToken } from '../apps/api/scanner-feed.mjs';

const origin = 'https://elpida.fun', bnb = { key: 'bnb-mainnet', chainId: 56, name: 'BNB Chain', mainnet: true, kind: 'evm', explorer: 'https://bscscan.com' };
const test1 = { key: 'bnb-testnet', chainId: 97, name: 'BNB testnet', mainnet: false, kind: 'evm' };
const row = (address, created, extra = {}) => ({ address, name: 'spiderman', symbol: 'SPIDERMAN', creator: '0x47c1a7c7d89d2c6bf6fd6835b913a6cce010062e', created, creationBlock: 1, hash: '0xabc', metadataURI: 'ipfs://bafk',
  metadata: { image: '/api/content/bafkreib27jeyze6d3onpz7fjgq6vs5uje2dtcqnu7lubcay6tcki37dvey', description: 'hope', website: 'https://elpida.fun', twitter: 'https://x.com/elpida', telegram: '', discord: 'javascript:alert(1)' },
  poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df', poolId: '0x' + '1'.repeat(64), hook: '0xe843acba3505ce2842b09f32aa5c9147615de8cc', quoteAddress: '0x' + '2'.repeat(40), quoteSymbol: 'AAPLon', pair: 'xstock', deploymentModel: 'v2-hook', feeBps: 125, ...extra });

test('one token: absolute image, safe links, chain facts and the pool', () => {
  const t = scannerToken(row('0xeeca39f2af81296de89685e6ddda58acd5ba1053', 1_795_300_000_000), bnb, origin);
  assert.equal(t.image, `${origin}/api/content/bafkreib27jeyze6d3onpz7fjgq6vs5uje2dtcqnu7lubcay6tcki37dvey`);
  assert.deepEqual(t.links, { website: 'https://elpida.fun', twitter: 'https://x.com/elpida' }, 'empty and unsafe links are dropped');
  assert.equal(t.address, '0xEEcA39F2AF81296dE89685E6ddda58Acd5Ba1053'); assert.equal(t.chainId, 56); assert.equal(t.createdAt, 1_795_300_000);
  assert.equal(t.pool.pairKind, 'xstock'); assert.equal(t.launchpad.url, `${origin}/token/bnb-mainnet/0xeeca39f2af81296de89685e6ddda58acd5ba1053`);
});

test('the feed: mainnet V2 launches only, newest first, paged', () => {
  const rows = { 'bnb-mainnet': [row('0x' + 'a'.repeat(40), 1_000_000), row('0x' + 'b'.repeat(40), 3_000_000), row('0x' + 'c'.repeat(40), 2_000_000, { deploymentModel: 'v1' })], 'bnb-testnet': [row('0x' + 'd'.repeat(40), 4_000_000)] };
  const f = scannerFeed({ networks: [bnb, test1], listings: k => rows[k] ?? [], origin });
  assert.deepEqual(f.tokens.map(t => t.createdAt), [3000, 1000]); assert.deepEqual(f.chains.map(c => c.chainId), [56]);
  assert.equal(scannerFeed({ networks: [bnb], listings: k => rows[k], origin, since: 2000 }).count, 1);
  assert.equal(scannerFeed({ networks: [bnb], listings: k => rows[k], origin, limit: 1 }).tokens.length, 1);
});

test('the server serves the feed and single tokens publicly', async t => {
  const { startServer } = await import('../apps/api/server.mjs');
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app' });
  t.after(() => app.close());
  const r = await fetch(`${app.url}/api/public/scanner/tokens`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const body = await r.json(); assert.equal(body.launchpad, 'Elpida'); assert.ok(Array.isArray(body.tokens));
  assert.equal((await fetch(`${app.url}/api/public/scanner/token/bnb-mainnet/0x${'e'.repeat(40)}`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/public/scanner/tokens?network=BAD!`)).status, 400);
});
