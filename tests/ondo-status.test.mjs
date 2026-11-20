// Ondo GM asset statuses (pauses, limits, sValue changes): parsing, the key staying on the server, the public endpoint,
// and the token-page notice text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatuses, createOndoStatus, STATUS_URL } from '../apps/api/ondo-status.mjs';
import './helpers/browser-modules.mjs';

const sample = [
  { symbol: 'XOMon', status: 'upcoming', type: 'scheduled', reason: { code: 'ASSET_LIMITED', message: 'earnings', documentation: 'x' }, start: '2026-11-30T10:00:00Z', end: '2026-12-01T00:30:00Z', eventId: 'a', updateSharesMultiplier: false },
  { symbol: 'TIPon', status: 'active', type: 'scheduled', reason: { code: 'ASSET_PAUSED', message: 'cash_dividend', documentation: 'x' }, start: '2026-11-19T00:50:00Z', end: '2026-11-21T01:00:00Z', updateSharesMultiplier: true },
  { symbol: 'OLDon', status: 'active', type: 'unscheduled', reason: { code: 'ASSET_PAUSED', message: 'maintenance' }, end: '2026-11-01T00:00:00Z' },
  { symbol: '<b>on', status: 'active', type: 'scheduled', reason: { code: 'ASSET_PAUSED', message: 'x' } },
  { symbol: 'AAPLon', status: 'weird', type: 'scheduled', reason: { code: 'ASSET_PAUSED', message: 'x' } },
  { symbol: 'NVDAon', status: 'upcoming', type: 'unscheduled', reason: { code: 'OTHER', message: 'x' } },
  { symbol: 'MSFTon', status: 'upcoming', type: 'unscheduled', reason: { code: 'ASSET_PAUSED', message: 'something new' } },
];
const now = () => Date.parse('2026-11-20T12:00:00Z');

test('parseStatuses keeps well-formed events and drops the rest', () => {
  const out = parseStatuses(sample);
  assert.deepEqual(out.map(e => e.symbol), ['XOMon', 'TIPon', 'OLDon', 'MSFTon']);
  assert.deepEqual(out[1], { symbol: 'TIPon', status: 'active', scheduled: true, kind: 'paused', reason: 'cash dividend', start: '2026-11-19T00:50:00.000Z', end: '2026-11-21T01:00:00.000Z', sValueChanges: true });
  assert.equal(out[3].reason, 'corporate action');
  assert.equal(out[3].start, null);
  assert.throws(() => parseStatuses({ data: [] }), /unexpected/);
});

test('the key goes only in the x-api-key header, never into results or logs; off without a key', async () => {
  const seen = [], logs = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(sample), { status: 200 }); };
  const s = createOndoStatus({ apiKey: 'secret-key-1234567890abcdefghij', fetchImpl, now, log: e => logs.push(e), autoRefresh: false });
  await s.refresh();
  assert.equal(seen[0].url, STATUS_URL); assert.equal(seen[0].init.headers['x-api-key'], 'secret-key-1234567890abcdefghij');
  const all = s.summary();
  assert.equal(all.enabled, true); assert.deepEqual(all.events.map(e => e.symbol), ['XOMon', 'TIPon', 'MSFTon'], 'ended events drop out');
  assert.deepEqual(s.summary('TIPon').events.length, 1);
  assert.doesNotMatch(JSON.stringify([all, logs]), /secret-key/);
  const bad = createOndoStatus({ apiKey: 'secret-key-1234567890abcdefghij', fetchImpl: async () => { throw new Error('boom secret-key-1234567890abcdefghij'); }, now, log: e => logs.push(e), autoRefresh: false });
  await bad.refresh();
  assert.doesNotMatch(JSON.stringify(logs), /secret-key-1234567890abcdefghij/);
  const off = createOndoStatus({ apiKey: '', fetchImpl: async () => { throw new Error('should not fetch'); }, autoRefresh: false });
  await off.refresh(); assert.deepEqual(off.summary(), { enabled: false, fetchedAt: null, events: [] });
});

test('API: /api/public/stock-status serves the summary and rejects odd symbols', async t => {
  const { startServer } = await import('../apps/api/server.mjs');
  const fake = { summary: sym => ({ enabled: true, fetchedAt: null, events: sym ? [{ symbol: sym }] : [] }), stop() {} };
  const app = await startServer({ port: 0, seed: false, publicUrl: 'https://elpida-preview.up.railway.app', ondoStatus: fake });
  t.after(() => app.close());
  const r = await fetch(`${app.url}/api/public/stock-status?symbol=TSLAon`);
  assert.equal(r.status, 200); assert.equal((await r.json()).events[0].symbol, 'TSLAon');
  assert.equal((await fetch(`${app.url}/api/public/stock-status?symbol=..%2Fx`)).status, 400);
  assert.equal((await fetch(`${app.url}/api/public/stock-status`)).status, 200);
});

test('token page notice: wording for upcoming and active events, nothing without an event', async () => {
  const { ondoStockNotice } = await import('../apps/web/token-page.mjs');
  const summary = { events: parseStatuses(sample) };
  assert.equal(ondoStockNotice(summary, 'AAPLon'), null);
  assert.match(ondoStockNotice(summary, 'TIPon', now()), /^TIPon: Ondo has paused minting and redemption for cash dividend, .+ Its share multiplier changes, so the stock price used here will step\. Trading here continues\.$/);
  assert.match(ondoStockNotice(summary, 'XOMon', now()), /will have limited minting and redemption for earnings/);
  assert.doesNotMatch(ondoStockNotice(summary, 'XOMon', now()), /multiplier/);
  assert.match(ondoStockNotice(summary, 'MSFTon', now()), /until further notice/);
  assert.match(readFileSync(new URL('../apps/web/token-page.mjs', import.meta.url), 'utf8'), /ondoNotice\(token, q\)/);
});
