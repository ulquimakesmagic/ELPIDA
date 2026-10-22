// The fork check picks an RPC that still holds recent state (BNB public nodes prune within seconds) and retries on
// pruned-state errors. Uses a fake RPC, so it runs offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserProvider } from 'ethers';
import { chooseForkRpc, isPrunedState, rootCause, FORK_RPC_FALLBACKS } from '../scripts/chain-fork-lifecycle.mjs';

const fakeChain = nodes => async (rpc, method, params) => {
  const n = nodes[rpc];
  if (!n || n.down) throw new Error('fetch failed');
  if (method === 'eth_chainId') return '0x' + n.chainId.toString(16);
  if (method === 'eth_blockNumber') return '0x' + n.head.toString(16);
  if (method === 'eth_gasPrice') return '0x3b9aca00';
  if (method === 'eth_getCode') { if (n.head - Number(BigInt(params[1])) > n.keeps) throw new Error('eth_getCode: missing trie node 1a2b'); return '0x'; }
  throw new Error('unexpected ' + method);
};
const quiet = { log: () => {} };

test('skips pruned, wrong-chain and unreachable RPCs and forks one block behind the head of the first good one', async () => {
  const call = fakeChain({
    'https://pruned.example': { chainId: 97, head: 1000, keeps: 0 },
    'https://wrong.example': { chainId: 56, head: 1000, keeps: 1e9 },
    'https://down.example': { down: true },
    'https://full.example': { chainId: 97, head: 2000, keeps: 128 },
  });
  const pick = await chooseForkRpc(Object.keys({ 'https://pruned.example': 1, 'https://wrong.example': 1, 'https://down.example': 1, 'https://full.example': 1 }), 97, 0, { call, ...quiet });
  assert.deepEqual(pick, { rpc: 'https://full.example', block: 1999, depth: 32, gasPrice: 1_000_000_000n });
  assert.equal(await chooseForkRpc(['https://pruned.example', 'https://down.example'], 97, 0, { call, ...quiet }), null);
});

test('each retry starts from the next RPC in the list', async () => {
  const call = fakeChain({ 'https://a.example': { chainId: 97, head: 10, keeps: 64 }, 'https://b.example': { chainId: 97, head: 20, keeps: 64 } });
  assert.equal((await chooseForkRpc(['https://a.example', 'https://b.example'], 97, 0, { call, ...quiet })).rpc, 'https://a.example');
  assert.equal((await chooseForkRpc(['https://a.example', 'https://b.example'], 97, 1, { call, ...quiet })).rpc, 'https://b.example');
});

test('pruned-state errors are recognised, including the exact BNB error and a wrapped cause; others are not', () => {
  assert.ok(isPrunedState(new Error('The response reported error `-32000`: `missing trie node`. (optional data: None)')));
  assert.ok(isPrunedState({ message: 'UnknownError', cause: new Error('missing trie node') }));
  assert.ok(isPrunedState(new Error('historical state not available in path scheme yet')));
  assert.ok(!isPrunedState(new Error('execution reverted: rebalance callback')));
  assert.ok(FORK_RPC_FALLBACKS['bnb-testnet'].length >= 3 && FORK_RPC_FALLBACKS['bnb-testnet'].every(u => u.startsWith('https://')));
});

test('an RPC with deep history (archive) is preferred over an earlier one that keeps little', async () => {
  const call = fakeChain({ 'https://shallow.example': { chainId: 97, head: 100000, keeps: 128 }, 'https://archive.example': { chainId: 97, head: 100000, keeps: 1e9 } });
  const pick = await chooseForkRpc(['https://shallow.example', 'https://archive.example'], 97, 0, { call, ...quiet });
  assert.equal(pick.rpc, 'https://archive.example'); assert.equal(pick.depth, 5000);
  assert.equal(FORK_RPC_FALLBACKS['bnb-testnet'][0], 'https://bnb-testnet.api.onfinality.io/public');
});

test('"missing revert data" from gas estimation exposes the real upstream cause and is retried', async () => {
  const eip1193 = { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_estimateGas') throw Object.assign(new Error('The response reported error `-32000`: `missing trie node`. (optional data: None)'), { code: -32603 });
    throw new Error('unexpected ' + method);
  } };
  const provider = new BrowserProvider(eip1193);
  const error = await provider.estimateGas({ to: '0x' + '1'.repeat(40), data: '0x' }).then(() => null, e => e);
  assert.match(error.shortMessage ?? error.message, /missing revert data/, 'this is what the PC run printed');
  assert.match(rootCause(error), /missing trie node/);
  assert.ok(isPrunedState(error), 'so the run retries instead of failing');
  const realRevert = await new BrowserProvider({ request: async ({ method }) => { if (method === 'eth_chainId') return '0x7a69'; throw Object.assign(new Error('VM Exception: reverted with reason string "rebalance callback"'), { code: 3, data: '0x' }); } })
    .estimateGas({ to: '0x' + '1'.repeat(40), data: '0x' }).then(() => null, e => e);
  assert.ok(!isPrunedState(realRevert), 'a genuine contract revert is reported, not retried');
  assert.doesNotMatch(realRevert.shortMessage, /missing revert data/, 'a real revert never prints "missing revert data"');
  assert.match(rootCause(realRevert), /rebalance callback/);
  assert.ok(isPrunedState(new Error('429 Too Many Requests')), 'rate limiting on the public RPC is retried');
});
