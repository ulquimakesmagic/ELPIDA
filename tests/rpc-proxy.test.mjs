import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRpcProxy, RPC_METHODS } from '../apps/api/server.mjs';

// The mainnet RPC proxy forwards only the app's methods, keeps the upstream URL server-side and rate limits.
test('Solana RPC proxy forwards allowed methods only and rate limits each address', async t => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: 'ok' }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const target = `http://127.0.0.1:${upstream.address().port}/?api-key=SECRET`;
  assert.equal(createRpcProxy('http://example.com'), null, 'plain http outside localhost is refused');
  assert.equal(createRpcProxy('https://example.com/?api-key=SECRET,https://other.example.com'), null, 'multiple endpoints cannot be forwarded as one URL');
  const proxy = createRpcProxy(target, { perSecond: 0.001, burst: 3 });
  const app = createServer((req, res) => proxy(req, res, (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }));
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const call = async body => { const r = await fetch(`http://127.0.0.1:${app.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const ok = await call({ jsonrpc: '2.0', id: 7, method: 'getAccountInfo', params: ['x'] });
  assert.equal(ok.status, 200); assert.equal(ok.json.result, 'ok');
  assert.equal(seen[0].url, '/?api-key=SECRET'); assert.equal(seen[0].body.method, 'getAccountInfo');
  assert.ok(RPC_METHODS.has('sendTransaction') && !RPC_METHODS.has('requestAirdrop'));
  assert.equal((await call({ jsonrpc: '2.0', id: 8, method: 'requestAirdrop', params: [] })).status, 400);
  assert.equal((await call([{ jsonrpc: '2.0', id: 9, method: 'getSlot' }])).status, 400, 'batches are refused');
  assert.equal((await call({ jsonrpc: '2.0', id: 10, method: 'getSlot' })).status, 429, 'burst of 3 used up');
  assert.equal(seen.length, 1);
});

test('Solana RPC proxy with several endpoints: a refused or failing endpoint is skipped, the one that answers is kept', async t => {
  const hits = { a: 0, b: 0 };
  const serve = (name, status) => createServer(async (req, res) => { for await (const _ of req); hits[name]++; res.writeHead(status(), { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: name })); });
  let aStatus = 429;
  const a = serve('a', () => aStatus), b = serve('b', () => 200);
  for (const s of [a, b]) { await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); }
  const url = s => `http://127.0.0.1:${s.address().port}/?api-key=K`;
  assert.equal(createRpcProxy(['http://example.com/?k=1', 'not a url']), null, 'no valid endpoint, no proxy');
  const proxy = createRpcProxy([url(a), 'http://example.com/?k=1', url(b)]);
  const app = createServer((req, res) => proxy(req, res, (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }));
  await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => app.close());
  const call = async () => (await (await fetch(`http://127.0.0.1:${app.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }) })).json()).result;
  assert.equal(await call(), 'b', 'the rate-limited endpoint is skipped');
  assert.equal(await call(), 'b', 'and the answering one is kept');
  assert.deepEqual(hits, { a: 1, b: 2 });
  aStatus = 200;
  assert.equal(await call(), 'b');
});
