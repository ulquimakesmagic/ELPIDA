import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { readOndoV3Execution } from '../scripts/lib/ondo-v3-execution.mjs';

const address = n => '0x' + n.repeat(40), token = address('1'), quote = address('2'), pool = address('3'), factory = address('4'), quoter = address('5');
const hash = '0x' + '12'.repeat(32), codeHash = keccak256('0x6000');
const abi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)',
  'function factory() view returns(address)', 'function getPool(address,address,uint24) view returns(address)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)']);
const args = () => ({ asset: { provider: 'ondo', network: 'ethereum', address: token }, balanceRaw: '2000000000000000000',
  snapshot: { chainId: 1, number: 100, hash }, policy: { network: 'ethereum', token, quoteToken: quote, pool, factory, quoter, poolCodeHash: codeHash, factoryCodeHash: codeHash, quoterCodeHash: codeHash, fee: 3000, buyProbeQuoteRaw: '200000000' } });
function rpc(changes = {}) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return changes.chain ?? '0x1';
    if (method === 'eth_getBlockByHash') return { number: '0x64', hash, timestamp: '0x3e8', ...changes.header };
    assert.deepEqual(params.at(-1), { blockHash: hash, requireCanonical: true });
    if (method === 'eth_getCode') return changes.code ?? '0x6000';
    assert.equal(method, 'eth_call');
    const call = abi.parseTransaction({ data: params[0].data });
    const values = { token0: token, token1: changes.token1 ?? quote, fee: 3000, factory, getPool: changes.pool ?? pool };
    if (call.name !== 'quoteExactInputSingle') return abi.encodeFunctionResult(call.fragment, [values[call.name]]);
    assert.equal(params[0].to, quoter);
    assert.equal(call.args[0].sqrtPriceLimitX96, 0n);
    if (changes.failQuote) throw new Error('quote reverted');
    return abi.encodeFunctionResult(call.fragment, [123n, 1n << 96n, 1, 80000]);
  };
  return { request, calls };
}

test('QuoterV2 reader pins code, canonical block, factory pool and exact probe directions using reads only', async () => {
  const mock = rpc(), input = args();
  const result = await readOndoV3Execution({ ...input, request: mock.request });
  assert.equal(result.sell.amountInRaw, input.balanceRaw); assert.equal(result.buy.amountInRaw, input.policy.buyProbeQuoteRaw);
  assert.equal(result.updatedAt, 1000); assert.equal(result.simulated, true);
  const quotes = mock.calls.filter(c => c.method === 'eth_call' && abi.parseTransaction({ data: c.params[0].data }).name === 'quoteExactInputSingle');
  assert.equal(quotes.length, 2);
  const directions = quotes.map(c => abi.parseTransaction({ data: c.params[0].data }).args[0].tokenIn.toLowerCase());
  assert.deepEqual(directions, [token, quote]);
  assert.ok(mock.calls.every(c => ['eth_chainId', 'eth_getBlockByHash', 'eth_getCode', 'eth_call'].includes(c.method)));
});
test('wrong-chain, substituted pool/assets/code, conflicting header and failed simulation never produce a sample', async () => {
  for (const changes of [{ chain: '0x38' }, { code: '0x6001' }, { token1: address('6') }, { pool: address('7') }, { header: { hash: '0x' + '34'.repeat(32) } }, { failQuote: true }]) {
    await assert.rejects(readOndoV3Execution({ ...args(), request: rpc(changes).request }));
  }
  const input = args(); input.policy.quoterCodeHash = undefined;
  await assert.rejects(readOndoV3Execution({ ...input, request: rpc().request }));
});
