import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
const address = value => /^0x[0-9a-f]{40}$/i.test(value ?? '') ? value.toLowerCase() : null;
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
const abi = new Interface(['function aggregator() view returns(address)', 'function decimals() view returns(uint8)',
  'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);

/** Read a reviewed quote-asset USD feed at a canonical block; never an Ondo stock reference/status feed. */
export async function readChainlinkQuoteUsd({ policy, snapshot, request }) {
  assert.ok(['ethereum', 'bnb'].includes(policy?.network));
  assert.equal(snapshot.chainId, ({ ethereum: 1, bnb: 56 })[policy.network]);
  assert.ok(address(policy.quoteToken) && address(policy.quoteFeed) && address(policy.quoteAggregator));
  assert.ok(hash(policy.quoteFeedCodeHash) && hash(policy.quoteAggregatorCodeHash));
  assert.ok(typeof policy.quoteFeedId === 'string' && policy.quoteFeedId.trim());
  assert.ok(typeof policy.quoteDescription === 'string' && policy.quoteDescription.trim());
  assert.ok(Number.isInteger(policy.quoteFeedDecimals) && policy.quoteFeedDecimals >= 0 && policy.quoteFeedDecimals <= 18);
  assert.ok(Number.isSafeInteger(policy.quoteMaxAgeSec) && policy.quoteMaxAgeSec > 0);
  assert.ok(Number.isSafeInteger(snapshot.number) && snapshot.number > 0 && hash(snapshot.hash));
  assert.equal(Number(BigInt(await request('eth_chainId', []))), snapshot.chainId);
  const header = await request('eth_getBlockByHash', [snapshot.hash, false]);
  assert.ok(header && header.hash.toLowerCase() === snapshot.hash.toLowerCase() && Number(BigInt(header.number)) === snapshot.number);
  const observedAt = Number(BigInt(header.timestamp)); assert.ok(Number.isSafeInteger(observedAt) && observedAt >= 0);
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  for (const [target, pin] of [[policy.quoteFeed, policy.quoteFeedCodeHash], [policy.quoteAggregator, policy.quoteAggregatorCodeHash]]) {
    const code = await request('eth_getCode', [target, block]);
    assert.notEqual(code, '0x'); assert.equal(keccak256(code), pin.toLowerCase());
  }
  const call = async name => abi.decodeFunctionResult(name, await request('eth_call', [{ to: policy.quoteFeed, data: abi.encodeFunctionData(name) }, block]));
  assert.equal(address((await call('aggregator'))[0]), address(policy.quoteAggregator), 'review feed aggregator changes');
  assert.equal(Number((await call('decimals'))[0]), policy.quoteFeedDecimals);
  assert.equal((await call('description'))[0], policy.quoteDescription);
  const [roundId, answer, startedAt, updated, answeredInRound] = await call('latestRoundData');
  assert.ok(roundId > 0n && answer > 0n && answeredInRound >= roundId);
  const updatedAt = Number(updated), started = Number(startedAt);
  assert.ok(Number.isSafeInteger(updatedAt) && Number.isSafeInteger(started) && started > 0 && started <= updatedAt);
  assert.ok(updatedAt > 0 && updatedAt <= observedAt && observedAt - updatedAt <= policy.quoteMaxAgeSec, 'quote round stale or future at observation block');
  return { network: policy.network, token: policy.quoteToken, feedId: policy.quoteFeedId, currency: 'USD', basis: 'per-raw-token',
    priceUsdWad: (answer * 10n ** BigInt(18 - policy.quoteFeedDecimals)).toString(), updatedAt, observedAt,
    blockNumber: snapshot.number, blockHash: snapshot.hash, roundId: roundId.toString(), aggregator: policy.quoteAggregator,
    liveCapabilitiesApproved: false, note: 'Quote-asset USD round only; not stock total return, corporate-action clearance or a guaranteed peg. Freshness evaluated at pinned block, not current wall clock.' };
}
