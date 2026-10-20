import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, retryDelay, safeToReload, startResilience } from '../apps/web/resilience.mjs';
import { startServer } from '../apps/api/server.mjs';

test('retry delay backs off and is capped', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [3000, 6000, 12000, 15000, 15000, 15000]);
});

test('a refresh is only safe on read-only routes with nothing focused', () => {
  assert.equal(safeToReload({ hash: '#/', activeTag: 'BODY' }), true);
  assert.equal(safeToReload({ hash: '#/docs' }), true);
  for (const hash of ['#/launch', '#/token/0xabc?network=base-sepolia', '#/rewards', '#/analytics']) assert.equal(safeToReload({ hash, activeTag: 'BODY' }), false, hash);
  assert.equal(safeToReload({ hash: '#/', activeTag: 'input' }), false);
});

test('decide: one failed probe is quiet, two show the strip, recovery clears it', () => {
  let s = decide({ known: 'a1', build: null, failures: 0 });
  assert.deepEqual([s.failures, s.banner, s.reload], [1, null, false]);
  s = decide({ known: 'a1', build: null, failures: 1 });
  assert.deepEqual([s.failures, s.banner], [2, 'offline']);
  s = decide({ known: 'a1', build: 'a1', failures: 2, hash: '#/' });
  assert.deepEqual([s.failures, s.banner, s.reload], [0, null, false]);
});

test('decide: a new build reloads on safe pages, otherwise offers a button; dev builds never reload', () => {
  assert.equal(decide({ known: 'a1', build: 'b2', failures: 2, hash: '#/', activeTag: 'BODY' }).reload, true);
  const risky = decide({ known: 'a1', build: 'b2', failures: 0, hash: '#/launch', activeTag: 'BODY' });
  assert.deepEqual([risky.reload, risky.banner], [false, 'update']);
  assert.equal(decide({ known: 'dev', build: 'b2', failures: 0, hash: '#/' }).reload, false);
  assert.equal(decide({ known: null, build: 'a1', failures: 0, hash: '#/' }).known, 'a1');
});

test('the strip shows while the server is away and a Refresh button when a new build arrived on a risky page', async () => {
  const listeners = {}, els = [];
  const mk = () => { const e = { children: [], dataset: {}, attrs: {}, hidden: false, textContent: '', className: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, append(...c) { this.children.push(...c); } }; els.push(e); return e; };
  const doc = { body: mk(), createElement: mk, addEventListener: (n, f) => { listeners[n] = f; }, visibilityState: 'visible', activeElement: { tagName: 'BODY' } };
  const loc = { hash: '#/launch', reload() { loc.reloaded = true; } };
  const answers = ['a1', null, null, 'b2'];
  const m = startResilience({ doc, loc, request: async () => answers.shift() });
  await new Promise(r => setTimeout(r, 5));
  const bar = doc.body.children[0];
  await m.tick(); await m.tick();
  assert.equal(bar.hidden, false); assert.equal(bar.dataset.kind, 'offline');
  await m.tick();
  assert.equal(bar.dataset.kind, 'update'); assert.equal(loc.reloaded, undefined);
  m.stop();
});

test('/health reports a build id and the shell loads the reconnect assets', async () => {
  const s = await startServer({ port: 0, seed: false });
  try {
    const body = await (await fetch(s.url + '/health')).json();
    assert.equal(body.status, 'ok'); assert.equal(typeof body.build, 'string'); assert.ok(body.build.length <= 12);
    for (const p of ['/resilience.mjs', '/resilience.css']) assert.equal((await fetch(s.url + p)).status, 200, p);
  } finally { await s.close(); }
});

test('Cloudflare fallback worker: passes Elpida responses through, replaces Railway failures with a self-refreshing 503', async () => {
  const { default: worker } = await import('../ops/cloudflare/fallback-worker.js');
  const real = globalThis.fetch;
  try {
    const cases = [
      [() => new Response('ok', { status: 200 }), 'https://elpida.fun/', 200, null],
      [() => new Response('{}', { status: 503, headers: { 'X-Request-Id': 'abc', 'Content-Type': 'application/json' } }), 'https://elpida.fun/api/config', 503, 'application/json'],
      [() => new Response('railway', { status: 502 }), 'https://elpida.fun/learn', 503, 'text/html'],
      [() => { throw new Error('down'); }, 'https://elpida.fun/', 503, 'text/html'],
      [() => new Response('railway', { status: 502 }), 'https://elpida.fun/api/tokens', 503, 'application/json'],
    ];
    for (const [impl, url, status, type] of cases) {
      globalThis.fetch = async () => impl();
      const r = await worker.fetch(new Request(url));
      assert.equal(r.status, status, url);
      if (type) assert.match(r.headers.get('content-type'), new RegExp(type), url);
      if (status === 503 && type === 'text/html') {
        const html = await r.text();
        assert.equal(r.headers.get('retry-after'), '10');
        assert.match(html, /http-equiv="refresh"/); assert.match(html, /noindex/); assert.ok(!/railway/i.test(html));
      }
    }
    globalThis.fetch = async () => new Response('railway', { status: 502 });
    assert.equal(await (await worker.fetch(new Request('https://elpida.fun/'))).text().then(t => t.includes('railway')), false);
  } finally { globalThis.fetch = real; }
});
