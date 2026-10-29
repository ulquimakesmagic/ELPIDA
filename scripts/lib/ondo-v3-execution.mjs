import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';

const addr = value => /^0x[0-9a-f]{40}$/i.test(value ?? '') ? value.toLowerCase() : null;
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
const uint = value => typeof value === 'bigint' && value > 0n || typeof value === 'string' && /^[1-9]\d*$/.test(value);
const abi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)',
  'function fee() view returns(uint24)', 'function factory() view returns(address)',
  'function getPool(address,address,uint24) view returns(address)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);

/** QuoterV2 simulation via eth_call only. Requires reviewed code pins; never chooses a venue or USD feed. */
export async function readOndoV3Execution({ asset, policy, snapshot, balanceRaw, request }) {
  assert.equal(asset?.provider, 'ondo');
  assert.ok(['ethereum', 'bnb'].includes(asset.network));
  assert.equal(snapshot?.chainId, ({ ethereum: 1, bnb: 56 })[asset.network]);
  assert.equal(policy?.network, asset.network);
  assert.ok(addr(asset.address) && addr(policy.token) === addr(asset.address));
  assert.ok(Number.isSafeInteger(snapshot.number) && snapshot.number > 0 && hash(snapshot.hash));
  assert.ok(uint(balanceRaw) && uint(policy.buyProbeQuoteRaw));
  assert.ok(Number.isInteger(policy.fee) && policy.fee > 0 && policy.fee < 1000000);
  assert.ok(addr(policy.quoteToken) && addr(policy.quoteToken) !== addr(asset.address));
  assert.equal(Number(BigInt(await request('eth_chainId', []))), snapshot.chainId);
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  const header = await request('eth_getBlockByHash', [snapshot.hash, false]);
  assert.ok(header && header.hash.toLowerCase() === snapshot.hash.toLowerCase() && Number(BigInt(header.number)) === snapshot.number);
  const updatedAt = Number(BigInt(header.timestamp)); assert.ok(Number.isSafeInteger(updatedAt) && updatedAt >= 0);
  for (const name of ['pool', 'factory', 'quoter']) {
    assert.ok(addr(policy[name]) && hash(policy[name + 'CodeHash']), `review ${name} identity and runtime`);
    assert.equal(keccak256(await request('eth_getCode', [policy[name], block])), policy[name + 'CodeHash'].toLowerCase());
  }
  const call = async (to, name, args = []) => abi.decodeFunctionResult(name, await request('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, block]));
  const [token0] = await call(policy.pool, 'token0'), [token1] = await call(policy.pool, 'token1');
  assert.deepEqual([addr(token0), addr(token1)].sort(), [addr(asset.address), addr(policy.quoteToken)].sort());
  assert.equal(Number((await call(policy.pool, 'fee'))[0]), policy.fee);
  assert.equal(addr((await call(policy.pool, 'factory'))[0]), addr(policy.factory));
  assert.equal(addr((await call(policy.quoter, 'factory'))[0]), addr(policy.factory));
  assert.equal(addr((await call(policy.factory, 'getPool', [token0, token1, policy.fee]))[0]), addr(policy.pool));
  const quote = async (tokenIn, tokenOut, amountIn) => {
    const values = await call(policy.quoter, 'quoteExactInputSingle', [[tokenIn, tokenOut, amountIn, policy.fee, 0]]);
    assert.ok(values[0] > 0n);
    return { amountInRaw: String(amountIn), amountOutRaw: values[0].toString() };
  };
  return { network: asset.network, token: asset.address, quoteToken: policy.quoteToken, pool: policy.pool,
    blockNumber: snapshot.number, blockHash: snapshot.hash, updatedAt,
    sell: await quote(asset.address, policy.quoteToken, balanceRaw),
    buy: await quote(policy.quoteToken, asset.address, policy.buyProbeQuoteRaw),
    simulated: true, note: 'QuoterV2 eth_call; no transaction, guaranteed fill, participant eligibility or USD price approval.' };
}
