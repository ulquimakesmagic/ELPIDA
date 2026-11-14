// Home page LCP (15 Nov 2026): the first trending logos are named as preloads in the HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homePreloads, withPreloads } from '../apps/api/home-preload.mjs';
import { startServer } from '../apps/api/server.mjs';

test('the first trending logos, ranked as the browser ranks them, become preloads; other hosts never do', () => {
  const now = 1_794_700_000, token = (address, volume24h, image, extra = {}) => ({ address, volume24h, trades24h: 1, image, pair: 'native', created: 1, ...extra });
  const sources = [{ network: 'base-sepolia', tokens: [token('0xa', 1, '/api/content/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), token('0xb', 5, 'https://elpida-old.up.railway.app/api/content/bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), token('0xc', 0, '/api/content/bafkreicccccccccccccccccccccccccccccccccccccccccccccccccccc')] },
    { network: 'bnb-testnet', tokens: [token('0xd', 3, 'https://example.com/logo.png'), token('0xe', 2, '/api/content/bafkreieeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', { metadata: { image: '/api/content/bafkreiffffffffffffffffffffffffffffffffffffffffffffffffffff' } })] }];
  const prices = { 'base-sepolia': { status: 'fresh', usd: 3000, updatedAt: now, source: 't' }, 'bnb-testnet': { status: 'fresh', usd: 600, updatedAt: now, source: 't' } };
  // Dollar volume: 0xb $15,000, 0xa $3,000, 0xd $1,800, 0xe $1,200; 0xc did not trade.
  assert.deepEqual(homePreloads({ sources, prices, now }), ['/api/content/bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?w=512', '/api/content/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?w=512']);
  assert.deepEqual(homePreloads({ sources, prices, now, limit: 3 }).length, 2, 'a logo on another host is not preloaded');
  assert.deepEqual(homePreloads({ sources: [], prices, now }), []);
  const html = withPreloads('<html><head><title>x</title></head><body></body></html>', ['/api/content/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?w=512']);
  assert.match(html, /<link rel="preload" as="image" href="\/api\/content\/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\?w=512" fetchpriority="high">\n<\/head>/);
  assert.equal(withPreloads('<head></head>', []), '<head></head>');
});

test('the home page is still served with no indexed networks', async t => {
  const app = await startServer({ port: 0, seed: false }); t.after(() => app.close());
  const res = await fetch(app.url + '/'); assert.equal(res.status, 200);
  const html = await res.text(); assert.match(html, /<\/head>/); assert.doesNotMatch(html, /rel="preload" as="image"/);
});
