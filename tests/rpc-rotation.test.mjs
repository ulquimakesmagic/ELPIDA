// Server RPC rotation (Malik, 25 Nov 2026): several ELPIDA_RPC_<chainId> URLs and ALCHEMY_API_KEYS, moving to the next
// when one runs out, for the keeper's provider and the price keeper alike. Keys never appear in logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serverRpcUrls, serverRpcUrl, rotateServerRpc, rpcExhausted } from '../packages/core/mainnets.mjs';
import { RotatingRpcProvider } from '../apps/api/rotating-provider.mjs';
import { productionGuard } from '../apps/api/production-guard.mjs';

test('ALCHEMY_API_KEYS expands every Alchemy URL; other URLs are kept; the public RPC is the last resort', () => {
  const net = { key: 'base-mainnet', chainId: 8453, rpcUrl: 'https://mainnet.base.org' };
  assert.deepEqual(serverRpcUrls(net, {}), ['https://mainnet.base.org']);
  const env = { ELPIDA_RPC_8453: 'https://base-mainnet.g.alchemy.com/v2/KEYONE111, https://other.example/rpc', ALCHEMY_API_KEYS: 'KEYTWO222,KEYONE111, bad key ,KEYTHREE33' };
  assert.deepEqual(serverRpcUrls(net, env), ['https://base-mainnet.g.alchemy.com/v2/KEYONE111', 'https://base-mainnet.g.alchemy.com/v2/KEYTWO222', 'https://base-mainnet.g.alchemy.com/v2/KEYTHREE33', 'https://other.example/rpc']);
  assert.equal(serverRpcUrl(net, env), 'https://base-mainnet.g.alchemy.com/v2/KEYONE111');
  assert.equal(rotateServerRpc(net, env, 'https://base-mainnet.g.alchemy.com/v2/KEYONE111'), true);
  assert.equal(serverRpcUrl(net, env), 'https://base-mainnet.g.alchemy.com/v2/KEYTWO222');
  rotateServerRpc(net, env, 'https://base-mainnet.g.alchemy.com/v2/KEYONE111');
  assert.equal(serverRpcUrl(net, env), 'https://base-mainnet.g.alchemy.com/v2/KEYTWO222', 'a stale report does not skip a working key');
  assert.equal(rotateServerRpc({ ...net, chainId: 1 }, {}, 'x'), false, 'nothing to rotate to');
  for (const e of [{ info: { responseStatus: '429 Too Many Requests' } }, { message: 'Monthly capacity limit exceeded.' }, { code: 429 }, { message: 'Must be authenticated!' }]) assert.ok(rpcExhausted(e), JSON.stringify(e));
  for (const e of [{ message: 'execution reverted' }, { message: 'nonce too low' }, { message: 'insufficient funds for gas * price + value' }]) assert.ok(!rpcExhausted(e), e.message);
});

test('the keeper provider moves to the next key when Alchemy says the monthly capacity is used up', async t => {
  const hits = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      hits.push(req.url); const ids = [].concat(JSON.parse(body)).map(p => p.id);
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/OLDKEY111')) { res.statusCode = 429; return res.end(JSON.stringify({ jsonrpc: '2.0', id: ids[0], error: { code: 429, message: 'Monthly capacity limit exceeded.' } })); }
      res.end(JSON.stringify([].concat(JSON.parse(body)).map(p => ({ jsonrpc: '2.0', id: p.id, result: p.method === 'eth_chainId' ? '0x2105' : '0x10' }))));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, logs = [];
  // A test-only shape: Alchemy expansion needs an alchemy.com host, so two plain URLs stand in for two keys here.
  const net = { key: 'test-chain', chainId: 991, rpcUrl: 'https://public.example' };
  const env = { ELPIDA_RPC_991: `${base}/v2/OLDKEY111,${base}/v2/NEWKEY222` };
  const provider = new RotatingRpcProvider(net, env, 8453, { staticNetwork: true, batchMaxCount: 1, log: e => logs.push(e) });
  assert.equal(await provider.getBlockNumber(), 16);
  assert.deepEqual(hits.slice(-2), ['/v2/OLDKEY111', '/v2/NEWKEY222']);
  assert.equal(serverRpcUrl(net, env), `${base}/v2/NEWKEY222`, 'the whole server now uses the new key');
  assert.deepEqual(logs, [{ event: 'server_rpc_rotated', network: 'test-chain', to: 2, of: 2 }]);
  assert.ok(!JSON.stringify(logs).includes('KEY'), 'the log names positions, never URLs or keys');
  await provider.getBlockNumber(); assert.equal(hits.at(-1), '/v2/NEWKEY222', 'later requests go straight to the new key');
  provider.destroy();
});

test('the production guard accepts a list of HTTPS RPCs and refuses a list with a local or plain one', () => {
  const evm = { mode: 'mainnet', networks: [{ key: 'base-mainnet', name: 'Base', chainId: 8453, mainnet: true, v2: { shared: {} } }], skipped: [] };
  const codes = env => productionGuard({ env: { ELPIDA_V2_KEEPER_KEY: '0x' + '1'.repeat(64), ...env }, evm }).errors.map(e => e.code).filter(c => c.startsWith('evm_rpc'));
  assert.deepEqual(codes({ ELPIDA_RPC_8453: 'https://base-mainnet.g.alchemy.com/v2/a, https://base.llamarpc.com' }), []);
  assert.deepEqual(codes({ ELPIDA_RPC_8453: 'https://base-mainnet.g.alchemy.com/v2/a,http://127.0.0.1:8545' }), ['evm_rpc_invalid']);
});
