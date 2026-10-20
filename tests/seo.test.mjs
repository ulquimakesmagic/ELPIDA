import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../apps/api/server.mjs';
import { PAGES, FAQ, renderPage, renderSitemap, renderRobots, renderLlms, jsonLd, websiteJsonLd, noscriptHtml, canonicalOrigin, DEFAULT_ORIGIN } from '../packages/core/seo.mjs';

const ld = html => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));

test('canonicalOrigin accepts only a bare https origin', () => {
  assert.equal(canonicalOrigin({}), DEFAULT_ORIGIN);
  assert.equal(canonicalOrigin({ ELPIDA_CANONICAL_ORIGIN: 'https://example.org' }), 'https://example.org');
  for (const bad of ['http://example.org', 'https://u:p@example.org', 'https://example.org/x', 'javascript:alert(1)', 'nope']) assert.equal(canonicalOrigin({ ELPIDA_CANONICAL_ORIGIN: bad }), DEFAULT_ORIGIN);
});

test('every public page has a sound title, description, one h1, a self canonical and parseable JSON-LD', () => {
  for (const page of PAGES) {
    const html = renderPage(page);
    assert.ok(page.title.length >= 20 && page.title.length <= 60, `${page.path} title length ${page.title.length}`);
    assert.ok(page.description.length >= 70 && page.description.length <= 160, `${page.path} description length ${page.description.length}`);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `${page.path} h1 count`);
    assert.ok(html.includes(`<link rel="canonical" href="${DEFAULT_ORIGIN}${page.path}">`));
    assert.ok(ld(html).length === 1 && ld(html)[0]['@graph'].length >= 2);
    assert.ok(!/<script(?![^>]*(src=|application\/ld\+json))/.test(html), 'no inline script');
    assert.ok(!/\sstyle=|<style/.test(html), 'no inline style');
  }
});

test('FAQ and HowTo structured data mirror visible content', () => {
  const faq = ld(renderPage(PAGES.find(p => p.path === '/learn/faq')))[0]['@graph'].find(n => n['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, FAQ.length);
  assert.ok(ld(renderPage(PAGES.find(p => p.path === '/learn/how-it-works')))[0]['@graph'].some(n => n['@type'] === 'HowTo'));
});

test('JSON-LD cannot break out of its script tag', () => {
  assert.ok(!jsonLd({ a: '</script><script>alert(1)</script>&' }).includes('<'));
});

test('sitemap is well formed, absolute and lists every page', () => {
  const xml = renderSitemap();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(xml.startsWith('<?xml'));
  for (const p of ['/', ...PAGES.map(p => p.path)]) assert.ok(locs.includes(`${DEFAULT_ORIGIN}${p === '/' ? '/' : p}`), p);
  assert.ok(locs.every(l => l.startsWith('https://')) && !xml.includes('#'));
  assert.equal(xml.match(/<url>/g).length, xml.match(/<\/url>/g).length);
  assert.ok(renderSitemap('https://example.org').includes('https://example.org/learn'));
});

test('robots.txt points at the sitemap, hides the API and does not block assets', () => {
  const robots = renderRobots();
  assert.match(robots, /^Sitemap: https:\/\/elpida\.fun\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.ok(!/Disallow: \/(assets|learn)?\s*$/m.test(robots));
  assert.ok(renderLlms().includes('/learn/faq'));
});

test('index.html carries canonical, robots meta, matching JSON-LD and a crawlable noscript', () => {
  const html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<link rel="canonical" href="https://elpida.fun/">'));
  assert.match(html, /<meta name="robots" content="index, follow/);
  assert.deepEqual(ld(html)[0], websiteJsonLd());
  const flat = v => v.replace(/\s+/g, ' ');
  assert.ok(flat(html).includes(flat(noscriptHtml())));
});

test('the server serves the SEO files and pages with the right types and headers', async () => {
  const s = await startServer({ port: 0, seed: false });
  try {
    const base = s.url;
    for (const [path, type] of [['/robots.txt', 'text/plain'], ['/sitemap.xml', 'application/xml'], ['/llms.txt', 'text/plain'], ['/learn.css', 'text/css'], ...PAGES.map(p => [p.path, 'text/html'])]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), new RegExp(type), path);
      if (path !== '/learn.css') assert.match(r.headers.get('cache-control'), /public/, path);
    }
    for (const path of ['/api/config', '/health']) assert.equal((await fetch(base + path)).headers.get('x-robots-tag'), 'noindex, nofollow', path);
    assert.equal((await fetch(base + '/learn/nope')).status, 404);
  } finally { await s.close(); }
});
