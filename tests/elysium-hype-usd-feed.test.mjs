import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, getAddress, getCreateAddress, id, parseEther, toBeHex } from 'ethers';
import { mined, parse, v2Fixture, v4Art } from './helpers/v2-fixture.mjs';

const DAY = 86_400;
const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
const HYPE_USD = parseEther('65');

test('the permissionless publisher queues the pinned Chainlink round and only the aliased publisher can deliver it', async t => {
  const f = await v2Fixture(t, { v23: true });
  const source = await f.deploy(v4Art('MockUsdFeed'), HYPE_USD);
  const inbox = await f.deploy(v4Art('MockElysiumInbox'));
  const Publisher = v4Art('ElpidaHypeUsdPublisher');
  await assert.rejects(f.deploy(Publisher, source.target, inbox.target, f.addresses[0]),
    error => error.data === id('BadConfiguration()').slice(0, 10));
  await mined(source.setDecimals(18));

  const nonce = await f.provider.getTransactionCount(f.addresses[0]);
  const receiver = getCreateAddress({ from: f.addresses[0], nonce: nonce + 1 });
  const publisher = await f.deploy(Publisher, source.target, inbox.target, receiver);
  const feed = await f.deploy(v4Art('ElpidaElysiumHypeUsdFeed'), publisher.target);
  assert.equal(feed.target, receiver);
  const alias = getAddress(toBeHex(BigInt.asUintN(160, BigInt(publisher.target) + ALIAS_OFFSET), 20));
  assert.equal(await feed.aliasedPublisher(), alias);
  assert.equal(await feed.decimals(), 18n);
  assert.equal(await feed.description(), 'HYPE / USD');
  await assert.rejects(feed.latestRoundData(), /InvalidRound/);

  const now = await f.now(), updatedAt = now - 90;
  await mined(source.set(HYPE_USD, updatedAt, 7, 7));
  const expected = [7n, HYPE_USD, BigInt(updatedAt), BigInt(updatedAt), 7n];
  const fee = 1_000_000_000_000_000n;
  const receipt = await mined(publisher.connect(f.signers[1]).relay(0, 120_000, 10_000_000, { value: fee }));
  const [queued] = parse(inbox, receipt, 'Retryable');
  const [event] = parse(publisher, receipt, 'RoundQueued');
  assert.deepEqual([...queued.args], [publisher.target, receiver, 0n, 0n, f.addresses[1], f.addresses[1], 120_000n,
    10_000_000n, feed.interface.encodeFunctionData('receiveRound', [expected]), fee]);
  assert.deepEqual([...event.args], [7n, 1n, BigInt(updatedAt)]);

  await assert.rejects(feed.connect(f.signers[1]).receiveRound.staticCall(expected), /UnauthorizedPublisher/);
  const reader = new Contract(feed.target, feed.interface, f.provider);
  await assert.rejects(reader.receiveRound.staticCall(expected, { from: publisher.target }), /UnauthorizedPublisher/);
  await f.provider.send('hardhat_impersonateAccount', [alias]);
  await f.provider.send('hardhat_setBalance', [alias, '0x100000000000000000']);
  const delivery = await f.provider.send('eth_sendTransaction', [{ from: alias, to: receiver, data: queued.args.data }]);
  assert.equal((await f.provider.getTransactionReceipt(delivery)).status, 1);
  assert.deepEqual([...(await feed.latestRoundData())], expected);

  await assert.rejects(reader.receiveRound.staticCall(expected, { from: alias }), /EarlierRound/);
  await assert.rejects(reader.receiveRound.staticCall([6n, HYPE_USD, now, now, 6n], { from: alias }), /EarlierRound/);
  await assert.rejects(reader.receiveRound.staticCall([8n, HYPE_USD, updatedAt - 1, updatedAt - 1, 8n], { from: alias }), /EarlierRound/);
  for (const bad of [[8n, -1n, now, now, 8n], [8n, HYPE_USD, now, now, 7n],
    [8n, HYPE_USD, now, now + 3600, 8n], [8n, HYPE_USD, now - DAY - 1, now - DAY - 1, 8n]]) {
    await assert.rejects(reader.receiveRound.staticCall(bad, { from: alias }), /InvalidRound/);
  }

  // The factory uses the verified HYPE price for both the $10 launch fee and the $25,000 virtual quote.
  const factory = await f.deploy(v4Art('ElpidaV2Factory'), f.treasury, 20_000, true);
  await mined(factory.connect(f.owner).configureUsdPricing(feed.target, DAY, f.usdc.target));
  assert.equal(await factory.launchFee(), (parseEther('10') + 64n) / 65n);
  assert.equal(await factory.nativeVirtualQuote(), (parseEther('25000') + 64n) / 65n);

  await mined(source.setDecimals(8));
  await assert.rejects(publisher.relay.staticCall(0, 120_000, 10_000_000), /InvalidRound/);
  await mined(source.setDecimals(18));
  await f.advance(DAY);
  await assert.rejects(publisher.relay.staticCall(0, 120_000, 10_000_000), /InvalidRound/);
  await assert.rejects(feed.latestRoundData(), /InvalidRound/);
  await assert.rejects(factory.launchFee(), error => error.data === id('InvalidRound()').slice(0, 10));
});
