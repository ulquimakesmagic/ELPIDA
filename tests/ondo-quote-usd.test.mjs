import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { readChainlinkQuoteUsd } from '../scripts/lib/ondo-quote-usd.mjs';
const address = n => '0x' + n.repeat(40), feed = address('1'), aggregator = address('2'), token = address('3'), hash = '0x' + '12'.repeat(32);
const abi = new Interface(['function aggregator() view returns(address)', 'function decimals() view returns(uint8)', 'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const input = () => ({ policy: { network: 'ethereum', quoteToken: token, quoteFeed: feed, quoteAggregator: aggregator, quoteFeedCodeHash: keccak256('0x6000'), quoteAggregatorCodeHash: keccak256('0x6000'), quoteFeedId: 'test-only', quoteDescription: 'USDC / USD', quoteFeedDecimals: 8, quoteMaxAgeSec: 60 }, snapshot: { chainId: 1, number: 100, hash } });
const rpc = (changes = {}) => async (method, params) => {
  if (method === 'eth_chainId') return changes.chain ?? '0x1';
  if (method === 'eth_getBlockByHash') return { hash, number: '0x64', timestamp: '0x3e8', ...changes.header };
  assert.deepEqual(params.at(-1), { blockHash: hash, requireCanonical: true });
  if (method === 'eth_getCode') return changes.code ?? '0x6000';
  assert.equal(method, 'eth_call'); assert.equal(params[0].to, feed);
  const call = abi.parseTransaction({ data: params[0].data });
  return abi.encodeFunctionResult(call.fragment, call.name === 'latestRoundData' ? changes.round ?? [10, 99900000, 990, 990, 10]
    : [({ aggregator, decimals: 8, description: 'USDC / USD', ...changes })[call.name]]);
};
test('quote USD preserves actual round timestamp and depeg value using exact WAD conversion', async () => {
  const r = await readChainlinkQuoteUsd({ ...input(), request: rpc() });
  assert.equal(r.priceUsdWad, '999000000000000000'); assert.equal(r.updatedAt, 990); assert.equal(r.observedAt, 1000);
  assert.equal(r.liveCapabilitiesApproved, false);
});
test('stale, future, nonpositive and incomplete rounds have no one-dollar fallback', async () => {
  for (const round of [[10, 1, 900, 939, 10], [10, 1, 1001, 1001, 10], [10, -1, 990, 990, 10], [10, 0, 990, 990, 10], [10, 1, 990, 990, 9], [0, 1, 990, 990, 0], [10, 1, 991, 990, 10], [10, 1, 0, 990, 10]]) {
    await assert.rejects(readChainlinkQuoteUsd({ ...input(), request: rpc({ round }) }));
  }
});
test('wrong network, code, decimals, description, aggregator or block prevents normalization', async () => {
  for (const change of [{ chain: '0x38' }, { code: '0x6001' }, { decimals: 18 }, { description: 'NVDA / USD' }, { aggregator: address('4') }, { header: { hash: '0x' + '34'.repeat(32) } }]) {
    await assert.rejects(readChainlinkQuoteUsd({ ...input(), request: rpc(change) }));
  }
});
