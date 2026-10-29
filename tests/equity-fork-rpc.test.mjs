import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForkRpc, forkSnapshot, archiveRead } from '../scripts/lib/equity-fork-rpc.mjs';

const snapshot = { chainId: 1, number: 100, hash: '0x' + 'ab'.repeat(32) };
const address = '0x' + '12'.repeat(20);
const params = [address, '0x64'];
async function setup(t, fetchImpl, overrides = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'elpida-equity-rpc-'));
  const proxy = await createForkRpc({ rpc: 'https://example.invalid/private-test-key', snapshot, cacheDir, fetchImpl, ...overrides });
  t.after(async () => { await proxy.close(); await rm(cacheDir, { recursive: true, force: true }); });
  return { proxy, cacheDir };
}
const result = value => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: value }) });

test('snapshot validates chain and block header before a fork can use it', async () => {
  const fetchImpl = async (_, request) => {
    const q = JSON.parse(request.body);
    return result(q.method === 'eth_chainId' ? '0x1' : q.method === 'eth_blockNumber' ? '0x69' : { number: '0x64', hash: snapshot.hash });
  };
  assert.deepEqual(await forkSnapshot('https://example.invalid', 1, null, { fetchImpl }), snapshot);
  await assert.rejects(forkSnapshot('https://example.invalid', 56, null, { fetchImpl }), /chain ID/);
  await assert.rejects(forkSnapshot('https://example.invalid', 1, 'bad', { fetchImpl }), /Invalid pinned/);
});

test('pinned reads survive restarts and requests are forwarded by canonical block hash', async t => {
  let calls = 0;
  const fetchImpl = async (_, request) => {
    calls++; const q = JSON.parse(request.body);
    assert.deepEqual(q.params[1], { blockHash: snapshot.hash, requireCanonical: true });
    return result('0x1234');
  };
  const { proxy, cacheDir } = await setup(t, fetchImpl);
  assert.equal(await proxy.request('eth_getCode', params), '0x1234');
  const restarted = await createForkRpc({ rpc: 'https://other.invalid/another-key', snapshot, cacheDir, fetchImpl });
  t.after(() => restarted.close());
  assert.equal(await restarted.request('eth_getCode', params), '0x1234');
  assert.equal(calls, 1); assert.equal(restarted.stats().hits, 1);
  const otherBlock = await createForkRpc({ rpc: 'https://example.invalid', snapshot: { ...snapshot, hash: '0x' + 'cd'.repeat(32) }, cacheDir, fetchImpl: async () => result('0x5678') });
  t.after(() => otherBlock.close());
  assert.equal(await otherBlock.request('eth_getCode', params), '0x5678');
});

test('mutable reads and RPC errors are never cached; duplicate pinned reads coalesce', async t => {
  let calls = 0;
  const { proxy } = await setup(t, async () => { calls++; await new Promise(r => setTimeout(r, 20)); return result('0x'); });
  await Promise.all([proxy.request('eth_getCode', params), proxy.request('eth_getCode', params)]);
  assert.equal(calls, 1); assert.equal(proxy.stats().coalesced, 1);
  await proxy.request('eth_getCode', [address, 'latest']); await proxy.request('eth_getCode', [address, 'latest']);
  assert.equal(calls, 3);
  let failures = 0;
  const bad = await setup(t, async () => { failures++; return { ok: true, json: async () => ({ error: { code: -32000, message: 'secret endpoint detail' } }) }; });
  await assert.rejects(bad.proxy.request('eth_getCode', params), /Archive read failed/);
  await assert.rejects(bad.proxy.request('eth_getCode', params), /Archive read failed/);
  assert.equal(failures, 2);
});

test('HTTP gateway refuses all write methods and preserves request IDs', async t => {
  let calls = 0;
  const { proxy } = await setup(t, async () => { calls++; return result('0x123'); });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sendTransaction', 'hardhat_setBalance']) {
    const response = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 42, method, params: [] }) });
    const body = await response.json(); assert.equal(body.id, 42); assert.ok(body.error);
  }
  assert.equal(calls, 0);
  const response = await fetch(proxy.url, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 2, method: 'eth_getCode', params }, { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params }]) });
  const body = await response.json(); assert.deepEqual(body.map(x => x.id), [2, 3]); assert.equal(calls, 1);
  assert.equal((await fetch(proxy.url)).status, 405);
});

test('corrupt cached state is fetched again; endpoint credentials never enter cache files', async t => {
  let calls = 0;
  const { proxy, cacheDir } = await setup(t, async () => { calls++; return result('0x123'); });
  await proxy.request('eth_getCode', params);
  const directory = join(cacheDir, '1', snapshot.hash);
  const files = await readdir(directory); assert.equal(files.length, 1);
  await writeFile(join(directory, files[0]), '{bad JSON');
  await proxy.request('eth_getCode', params); assert.equal(calls, 2);
  const { readFile } = await import('node:fs/promises');
  const contents = await readFile(join(directory, files[0]), 'utf8');
  assert.equal(contents.includes('private-test-key'), false); assert.equal(contents.includes('example.invalid'), false);
});

test('archive requests enforce a deadline and redact transport and upstream errors', async () => {
  // The fake request holds a normal (ref'd) timer until the deadline aborts it. AbortSignal.timeout's own timer does not
  // keep the event loop alive, so with nothing else pending Node could cancel the test before the deadline fired.
  const fetchImpl = async (_, options) => new Promise((resolve, reject) => {
    const slow = setTimeout(resolve, 5000);
    options.signal.addEventListener('abort', () => { clearTimeout(slow); reject(new Error('private-test-key')); }, { once: true });
  });
  await assert.rejects(archiveRead('https://example.invalid/private-test-key', 'eth_chainId', [], { timeoutMs: 10, fetchImpl }), error => /timed out/.test(error.message) && !error.message.includes('private-test-key'));
});
