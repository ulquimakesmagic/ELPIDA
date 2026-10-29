// Test tooling only: forwards read calls to an archive RPC; never forwards transactions.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const HASH = /^0x[0-9a-f]{64}$/i;
const READS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getProof', 'eth_call', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const BLOCK_INDEX = { eth_getCode: 1, eth_getBalance: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2, eth_getProof: 2, eth_call: 1, eth_getBlockByNumber: 0 };
const digest = value => createHash('sha256').update(value).digest('hex');

export async function archiveRead(rpc, method, params = [], { timeoutMs = 25000, fetchImpl = fetch } = {}) {
  if (!READS.has(method)) throw new Error('Upstream method is not read-only.');
  try {
    const response = await fetchImpl(rpc, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error();
    return body.result;
  } catch { throw new Error(`Archive read failed or timed out (${method}); endpoint details omitted.`); }
}

export async function forkSnapshot(rpc, chainId, requestedBlock = null, options = {}) {
  const read = (method, params) => archiveRead(rpc, method, params, options);
  if (Number(BigInt(await read('eth_chainId', []))) !== chainId) throw new Error('Archive RPC chain ID mismatch.');
  const number = requestedBlock == null ? Number(BigInt(await read('eth_blockNumber', []))) - 5 : Number(requestedBlock);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pinned fork block.');
  const header = await read('eth_getBlockByNumber', ['0x' + number.toString(16), false]);
  if (!header || Number(BigInt(header.number)) !== number || !HASH.test(header.hash)) throw new Error('Pinned block header is unavailable or invalid.');
  return { chainId, number, hash: header.hash.toLowerCase() };
}

/** Cache only immutable, explicitly pinned reads. Mutable tags, errors and receipts are not cached. */
export async function createForkRpc({ rpc, snapshot, cacheDir, timeoutMs = 25000, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(snapshot.chainId) || snapshot.chainId < 1 || !Number.isSafeInteger(snapshot.number) || snapshot.number < 1 || !HASH.test(snapshot.hash)) throw new Error('Invalid fork snapshot.');
  const hash = snapshot.hash.toLowerCase(), block = '0x' + snapshot.number.toString(16);
  const directory = join(cacheDir, String(snapshot.chainId), hash);
  await mkdir(directory, { recursive: true });
  const counts = { upstream: 0, hits: 0, coalesced: 0, failures: 0 };
  const pending = new Map();
  const cacheable = (method, params) => {
    if (method === 'eth_getBlockByHash') return String(params[0]).toLowerCase() === hash;
    if (!Object.hasOwn(BLOCK_INDEX, method)) return false;
    const tag = params[BLOCK_INDEX[method]];
    return tag === block || (tag && typeof tag === 'object' && String(tag.blockHash).toLowerCase() === hash && tag.requireCanonical === true);
  };
  async function request(method, params = []) {
    if (!READS.has(method)) throw new Error('Upstream method is not read-only.');
    if (!Array.isArray(params)) throw new Error('RPC params must be an array.');
    const key = digest(JSON.stringify({ method, params })), immutable = cacheable(method, params);
    const path = join(directory, key + '.json');
    if (immutable) {
      try {
        const cached = JSON.parse(await readFile(path, 'utf8'));
        if (cached.version === 1 && cached.key === key && cached.blockHash === hash && Object.hasOwn(cached, 'result') && cached.checksum === digest(JSON.stringify(cached.result))) { counts.hits++; return cached.result; }
      } catch { /* A missing or corrupt entry is fetched again. */ }
      if (pending.has(key)) { counts.coalesced++; return pending.get(key); }
    }
    const task = (async () => {
      counts.upstream++;
      let result;
      const forwarded = [...params];
      let readMethod = method;
      if (immutable && method === 'eth_getBlockByNumber') { readMethod = 'eth_getBlockByHash'; forwarded[0] = hash; }
      else if (immutable && Object.hasOwn(BLOCK_INDEX, method)) forwarded[BLOCK_INDEX[method]] = { blockHash: hash, requireCanonical: true };
      try { result = await archiveRead(rpc, readMethod, forwarded, { timeoutMs, fetchImpl }); }
      catch (error) { counts.failures++; throw error; }
      if (immutable) {
        const entry = { version: 1, key, blockHash: hash, result, checksum: digest(JSON.stringify(result)) };
        const temporary = path + '.' + process.pid + '.tmp';
        try { await writeFile(temporary, JSON.stringify(entry)); await rename(temporary, path); } catch { /* Cache failure must not fabricate a successful RPC result. */ }
      }
      return result;
    })();
    if (immutable) pending.set(key, task);
    try { return await task; } finally { if (immutable) pending.delete(key); }
  }
  const respond = async q => {
    try { if (!q || q.jsonrpc !== '2.0' || typeof q.method !== 'string') throw new Error('Invalid JSON-RPC request.'); return { jsonrpc: '2.0', id: q.id ?? null, result: await request(q.method, q.params ?? []) }; }
    catch { return { jsonrpc: '2.0', id: q?.id ?? null, error: { code: -32000, message: 'Read-only archive request refused, failed or timed out.' } }; }
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 262144) throw new Error(); }
      const q = JSON.parse(body);
      if (Array.isArray(q) && (!q.length || q.length > 50)) throw new Error();
      // Bound batch concurrency; fork clients can still make independent read requests.
      const result = Array.isArray(q) ? await (async () => { const out = []; for (const item of q) out.push(await respond(item)); return out; })() : await respond(q);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, request, stats: () => ({ ...counts }), close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
