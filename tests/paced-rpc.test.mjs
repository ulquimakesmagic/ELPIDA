// Base Sepolia's public RPC refuses bursts ("25/second request limit reached", code -32007). The wallet's read of a
// network makes dozens of calls; before pacing, one refusal failed the whole read and the trade panel was disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FetchRequest, Contract } from 'ethers';
import './helpers/browser-modules.mjs';
const { PacedJsonRpcProvider, isRateLimited } = await import('../apps/web/paced-rpc.mjs');

/** A fake public RPC: answers eth_call with 1, refusing `refuse` of the first requests like Base Sepolia does. */
function fakeRpc({ refuse = 0, http429 = 0 } = {}) {
  const seen = { requests: 0, starts: [] };
  const request = new FetchRequest('https://rpc.test');
  request.getUrlFunc = async req => {
    seen.requests++; seen.starts.push(Date.now());
    const body = JSON.parse(new TextDecoder().decode(req.body)), one = Array.isArray(body) ? body : [body];
    if (http429 > 0) { http429--; return { statusCode: 429, statusMessage: 'Too Many Requests', headers: {}, body: new TextEncoder().encode('{}') }; }
    const reply = one.map(r => refuse > 0 ? (refuse--, { jsonrpc: '2.0', id: r.id, error: { code: -32007, message: '25/second request limit reached' } })
      : { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x14a34' : '0x' + '1'.padStart(64, '0') });
    return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(Array.isArray(body) ? reply : reply[0])) };
  };
  return { request, seen };
}
const read = provider => new Contract('0x' + '1'.repeat(40), ['function sold() view returns(uint256)'], provider).sold();

test('rate-limit refusals are recognised in the forms public RPCs use', () => {
  assert.ok(isRateLimited({ code: -32007, message: '25/second request limit reached' }));
  assert.ok(isRateLimited({ code: -32029, message: 'Too Many Requests' }));
  assert.ok(isRateLimited({ message: 'rate limit exceeded' }));
  assert.ok(!isRateLimited({ code: 3, message: 'execution reverted' }), 'a real revert is not retried');
});

test('a burst of 40 reads all succeed although the RPC refuses the first 6, and starts are paced', async () => {
  const { request, seen } = fakeRpc({ refuse: 6 });
  const slept = [];
  const provider = new PacedJsonRpcProvider(request, 84532, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 }, { perSecond: 200, backoffMs: 5, sleep: ms => { slept.push(ms); return new Promise(r => setTimeout(r, ms)); } });
  const results = await Promise.all(Array.from({ length: 40 }, () => read(provider)));
  assert.ok(results.every(v => v === 1n), 'every read returned');
  assert.equal(seen.requests, 46, 'the 6 refused calls were retried once each');
  assert.ok(slept.length > 0, 'requests were spaced and retries backed off');
  provider.destroy();
});

test('HTTP 429 is retried; a refusal that never clears still fails after the retries', async () => {
  let { request } = fakeRpc({ http429: 2 });
  let provider = new PacedJsonRpcProvider(request, 84532, { staticNetwork: true, batchMaxCount: 1 }, { perSecond: 1000, backoffMs: 1 });
  assert.equal(await read(provider), 1n); provider.destroy();
  ({ request } = fakeRpc({ refuse: 100 }));
  provider = new PacedJsonRpcProvider(request, 84532, { staticNetwork: true, batchMaxCount: 1 }, { perSecond: 1000, retries: 2, backoffMs: 1 });
  await assert.rejects(read(provider));
  provider.destroy();
});
