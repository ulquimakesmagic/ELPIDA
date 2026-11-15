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

test('the home page draws the first trending logos into the app\'s own loading skeleton, in rank order', async () => {
  const { withFirstScreen, homeFirstScreen, trendingLogos } = await import('../apps/api/home-preload.mjs');
  const page = '<main id="main"><div id="view" aria-busy="true">\n<!-- c -->\n<div class="page-head"><div><h1>Create</h1><p class="muted">Loading…</p></div></div>\n</div></main>';
  const a = '/api/content/bafkrei' + 'a'.repeat(52) + '?w=512';
  const out = withFirstScreen(page, [null, a]);
  assert.doesNotMatch(out, /page-head/); assert.match(out, /<div class="explore" aria-busy="true">/);
  const cards = out.match(/<li class="trend-card trend-skeleton">.*?<\/li>/g);
  assert.equal(cards.length, 5); assert.match(cards[0], /tc-media skeleton/); assert.match(cards[1], new RegExp(`<img alt="" src="${a.replace(/[?]/g, '\\?')}" decoding="async" fetchpriority="high">`));
  assert.equal(out.match(/list-skeleton/g).length, 6);
  assert.equal(withFirstScreen(page, [null, null]), page, 'no logo of our own: the page is unchanged');
  assert.equal(withFirstScreen('<div id="view"></div>', [a]), '<div id="view"></div>');
  assert.equal(homeFirstScreen([]).match(/tc-media skeleton/g).length, 5);
  assert.deepEqual(trendingLogos({ sources: [{ network: 'x', tokens: [{ address: '0x1', volume24h: 2, image: 'https://example.com/a.png' }, { address: '0x2', volume24h: 1, image: '/api/content/bafkrei' + 'a'.repeat(52) }] }], limit: 3, now: 1 }), [null, a]);
});

test('a V2 token whose logo is only in its launch metadata gets its stored logo, never a network fetch', async () => {
  const { storedMetadataImage, trendingLogos } = await import('../apps/api/home-preload.mjs');
  const meta = 'bafkrei' + 'm'.repeat(52), logo = 'bafkrei' + 'l'.repeat(52);
  const doc = { schema: 'elpida-token-v1', name: 'Iphone Duo', symbol: 'IDUO', image: `ipfs://${logo}` };
  const records = new Map([[meta, { type: 'application/json', data: Buffer.from(JSON.stringify(doc)).toString('base64') }], [logo, { type: 'image/png', data: '' }]]);
  const store = { get: cid => records.get(cid) ?? null };
  assert.equal(storedMetadataImage(store, { metadataURI: `ipfs://${meta}` }), `/api/content/${logo}`);
  assert.equal(storedMetadataImage(store, { metadataURI: 'ipfs://bafkrei' + 'x'.repeat(52) }), '', 'not stored here: nothing, no fetch');
  assert.equal(storedMetadataImage({ get: () => ({ type: 'application/json', data: Buffer.from('{"schema":"other","image":"ipfs://x"}').toString('base64') }) }, { metadataURI: `ipfs://${meta}` }), '');
  assert.equal(storedMetadataImage(store, {}), '');
  const sources = [{ network: 'base-sepolia', tokens: [{ address: '0x1', volume24h: 5, metadataURI: `ipfs://${meta}`, metadata: {} }, { address: '0x2', volume24h: 1, image: '/api/content/bafkrei' + 'a'.repeat(52) }] }];
  assert.deepEqual(trendingLogos({ sources, now: 1, limit: 2, imageOf: t => storedMetadataImage(store, t) }), [`/api/content/${logo}?w=512`, '/api/content/bafkrei' + 'a'.repeat(52) + '?w=512']);
  assert.deepEqual(trendingLogos({ sources, now: 1, limit: 2 }), [null, '/api/content/bafkrei' + 'a'.repeat(52) + '?w=512'], 'without the store the first card keeps its shimmer');
});

test('server-drawn trending cards carry the rank, name and ticker, escaped', async () => {
  const { homeFirstScreen, trendingCards } = await import('../apps/api/home-preload.mjs');
  const a = '/api/content/bafkrei' + 'a'.repeat(52) + '?w=512';
  const html = homeFirstScreen([{ src: a, name: 'Iphone <Duo>', symbol: 'I"DUO' }, { src: null, name: 'Elsewhere', symbol: 'ELS' }]);
  assert.match(html, /<span class="rank-chip">#1<\/span><div class="tc-band"><h3 class="tc-name">Iphone &lt;Duo&gt;<\/h3><span class="tc-ticker">\$I&quot;DUO<\/span><\/div>/);
  assert.match(html, /<div class="tc-media skeleton"><\/div>/, 'a logo on another host keeps the plain shimmer (same size as the app\'s skeleton)');
  assert.doesNotMatch(html, /<Duo>/);
  const cards = trendingCards({ sources: [{ network: 'x', tokens: [{ address: '0x1', volume24h: 1, image: a.split('?')[0], metadata: { name: 'Eren', symbol: 'EREN' } }] }], now: 1 });
  assert.deepEqual(cards, [{ src: a, name: 'Eren', symbol: 'EREN' }]);
});
