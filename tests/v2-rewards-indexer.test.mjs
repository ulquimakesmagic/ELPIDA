// The Rewards figures on the analytics page, read back from chain events and checked against the contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress } from 'ethers';
import { v2Fixture, launchV2, trade, mined } from './helpers/v2-fixture.mjs';
import { buildRound } from '../packages/core/v2-rounds.mjs';
import { V2RewardsIndexer, toJson } from '../packages/indexer/v2-rewards.mjs';
import { V2RewardsService, stockUsd } from '../apps/api/v2-rewards-service.mjs';
import { v4Art } from './helpers/v2-fixture.mjs';

const DAY = 86_400;
const chainNow = async f => (await f.provider.getBlock('latest')).timestamp;

test('vault sizes by day, rounds, countdown and flywheel burns match the chain', async t => {
  const f = await v2Fixture(t, { vaults: true }), { airdrop, holder, flywheel } = f.contracts, keeper = f.signers[4];
  const index = new V2RewardsIndexer({ provider: f.provider, contracts: { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target } });
  const l = await launchV2(f, { feeBps: 250 });
  await f.advance(61);
  for (let day = 0; day < 3; day++) {
    for (const i of [1, 2, 3]) await trade(f, l, { signer: f.signers[i], buy: true, amount: parseEther(String(0.2 * i)) });
    await f.advance(DAY);
  }
  await mined(f.hook.withdrawFees(l.token.target));
  // Pay this month's airdrop round once it ends.
  const round = Number(await airdrop.currentRound()), pool = await f.provider.getBalance(airdrop.target), chainId = (await f.provider.getNetwork()).chainId;
  const m = buildRound({ chainId, distributor: airdrop.target, round, asset: ZeroAddress }, [[f.addresses[1], pool / 2n], [f.addresses[2], pool / 3n], [f.addresses[3], pool - pool / 2n - pool / 3n]]);
  await f.provider.send('evm_setNextBlockTimestamp', [Number(await airdrop.roundEnd(round))]);
  await mined(airdrop.connect(keeper).postRoot(round, ZeroAddress, m.root, m.total, m.recipients, 'ipfs://round'));
  await mined(airdrop.connect(keeper).claimMany(round, ZeroAddress, m.entries.slice(0, 2).map(e => [e.account, e.amount, e.proof])));
  // A flywheel cycle, and more trading after it.
  const fwPool = await f.provider.getBalance(flywheel.target);
  await mined(flywheel.connect(keeper).buyAndBurn(l.token.target, fwPool / 10n, 1n, 1));
  await trade(f, l, { buy: true, amount: parseEther('0.4') });

  await index.sync();
  const now = await chainNow(f), s = index.summary(now), [owed] = await f.hook.ledgers(l.token.target);
  // Size = what the hook still owes the vault + what the vault holds (including amounts promised to a round).
  const native = v => v.assets.find(a => a.asset === ZeroAddress.toLowerCase());
  assert.equal(native(s.airdrop).size, owed[1] + await f.provider.getBalance(airdrop.target));
  assert.equal(native(s.holder).size, owed[3] + await f.provider.getBalance(holder.target));
  assert.equal(native(s.flywheel).size, owed[2] + await f.provider.getBalance(flywheel.target));
  // The analytics headline: every V2 fee so far and the creators' 30% of it, exactly as the hook books them.
  const ledger = await f.hook.ledgers(l.token.target), fee = s.fees.find(x => x.asset === ZeroAddress.toLowerCase());
  assert.equal(fee.creator, ledger.owed[0] + ledger.paid[0], 'creator share = what the hook owes the creator + what it paid');
  assert.ok(fee.total >= fee.creator * 10n / 3n && fee.total <= fee.creator * 10n / 3n + 10n, 'creators get 30% of the total');
  // One point per UTC day, growing while traders trade.
  const series = native(s.airdrop).series;
  assert.ok(series.length >= 4);
  for (let i = 1; i < series.length; i++) assert.equal(series[i].day - series[i - 1].day, DAY);
  assert.ok(series[1].size > series[0].size && series[2].size > series[1].size);
  // The round: posted total, two of three paid, statistics of what was paid.
  const [r] = s.airdrop.rounds;
  assert.equal(r.round, round); assert.equal(r.total, BigInt(m.total)); assert.equal(r.recipients, 3); assert.equal(r.paidRecipients, 2);
  assert.equal(r.unclaimed, BigInt(m.entries[2].amount)); assert.equal(r.manifestURI, 'ipfs://round');
  assert.equal(r.stats.recipients, 2); assert.equal(r.end, Number(await airdrop.roundEnd(round)));
  // The countdown is the contract's own schedule.
  assert.equal(s.airdrop.countdown.round, Number(await airdrop.currentRound()));
  assert.equal(s.airdrop.countdown.endsAt, Number(await airdrop.roundEnd(s.airdrop.countdown.round)));
  assert.equal(s.holder.countdown.endsAt - Number(await holder.roundStart(s.holder.countdown.round)), 7 * DAY);
  // Flywheel burns, as recorded on chain.
  assert.equal(s.flywheel.burns.length, 1); assert.equal(s.flywheel.cycles, 1);
  assert.equal(s.flywheel.burns[0].supplyAfter, await l.token.totalSupply());
  assert.equal(s.flywheel.burnedByToken[0].amount, await flywheel.burnedOf(l.token.target));
  assert.equal(index.burnedByToken().get(l.token.target.toLowerCase()), await flywheel.burnedOf(l.token.target), 'per-token burns for the Explore tag');
  // A trader can look up what they received.
  assert.equal(index.payoutsOf(f.addresses[1]).length, 1);
  assert.equal(index.payoutsOf(f.addresses[3]).length, 0);
  // The API copy has no BigInt.
  assert.equal(typeof toJson(s).airdrop.rounds[0].total, 'string');
  // Syncing again reads only new blocks and changes nothing.
  await index.sync();
  const again = toJson(index.summary(now)), first = toJson(s);
  delete again.status.lastSync; delete first.status.lastSync;
  assert.deepEqual(again, first);
});

test('the public service: hidden without a pinned V2 deployment, live with one, never on mainnet', async t => {
  assert.deepEqual(new V2RewardsService({ networks: [{ key: 'base-sepolia', v4: {} }] }).summary(), { deployed: false, chains: [] });
  const f = await v2Fixture(t, { vaults: true }), { airdrop, holder, flywheel } = f.contracts;
  const shared = { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target, block: 0 };
  const net = { key: 'base-sepolia', name: 'Base Sepolia', rpcUrl: 'local', explorer: 'https://sepolia.basescan.org', nativeCurrency: { symbol: 'ETH' }, v2: { shared } };
  assert.equal(new V2RewardsService({ networks: [{ ...net, mainnet: true }], providerFactory: () => f.provider }).deployed, false, 'mainnet needs its own approval');
  const service = new V2RewardsService({ networks: [net], providerFactory: () => f.provider, log: () => {} });
  const l = await launchV2(f);
  await f.advance(61);
  await trade(f, l, { buy: true, amount: parseEther('1') });
  await service.entries[0].index.sync();
  const s = service.summary({ 'base-sepolia': { status: 'fresh', usd: 2500 } });
  assert.equal(s.deployed, true); assert.equal(s.chains[0].assets[ZeroAddress].usd, 2500);
  assert.ok(BigInt(s.chains[0].airdrop.assets[0].size) > 0n);
  assert.equal(service.summary({ 'base-sepolia': { status: 'stale', usd: 2500 } }).chains[0].assets[ZeroAddress].usd, null, 'no stale dollar figures');
  // Pair assets come from the V2 token records: USDC is priced at $1, other tokens stay in their own units.
  const usdcAddr = f.usdc.target, stockAddr = f.stock.target;
  const priced = service.summary({}, undefined, () => [{ pair: 'usdc', quoteAddress: usdcAddr, quoteSymbol: 'USDC', quoteDecimals: 6 }, { pair: 'xstock', quoteAddress: stockAddr, quoteSymbol: 'tNVDAon', quoteDecimals: 18 }, { pair: 'native', quoteAddress: ZeroAddress }]);
  assert.deepEqual(priced.chains[0].assets[usdcAddr.toLowerCase()], { symbol: 'USDC', decimals: 6, usd: 1 });
  assert.deepEqual(priced.chains[0].assets[stockAddr.toLowerCase()], { symbol: 'tNVDAon', decimals: 18, usd: 180 }, 'no feed: the round test price, as on the token page');
  // Once its feed has answered, the stock is priced in dollars (refreshPrices fills this from the feed).
  service.entries[0].prices.set(stockAddr.toLowerCase(), { usd: 180, at: Date.now() });
  assert.equal(service.summary({}, undefined, () => [{ pair: 'xstock', quoteAddress: stockAddr, quoteSymbol: 'tNVDAon', quoteDecimals: 18 }]).chains[0].assets[stockAddr.toLowerCase()].usd, 180);
  assert.throws(() => service.payouts('nope'), /wallet address/);
  assert.deepEqual(service.payouts(f.addresses[1]).chains[0].payouts, []);
});

test('public RPCs that cap eth_getLogs ranges: the index halves its range and carries on', async t => {
  const f = await v2Fixture(t, { vaults: true }), { airdrop, holder, flywheel } = f.contracts;
  const l = await launchV2(f);
  await f.advance(61);
  await trade(f, l, { buy: true, amount: parseEther('1') });
  // Base Sepolia's public node: "eth_getLogs is limited to a 200 range", sent as HTTP 413.
  let refused = 0;
  const capped = new Proxy(f.provider, { get(target, prop) {
    if (prop === 'getLogs') return async filter => {
      if (filter.toBlock - filter.fromBlock + 1 > 3) { refused++; const e = new Error('server response 413 Payload Too Large'); e.info = { responseBody: '{"error":{"code":-32614,"message":"eth_getLogs is limited to a 200 range"}}' }; throw e; }
      return target.getLogs(filter);
    };
    const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  const index = new V2RewardsIndexer({ provider: capped, contracts: { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target }, batchSize: 100 });
  await index.sync();
  assert.ok(refused > 0, 'the cap was hit'); assert.ok(index.batchSize <= 3, 'and the range shrank to fit');
  assert.equal(index.status().error, null);
  assert.ok(BigInt(index.summary(await chainNow(f)).airdrop.assets[0].size) > 0n, 'the trade still reached the airdrop vault');
  // Other errors are not range caps: they surface instead of shrinking forever.
  const broken = new V2RewardsIndexer({ provider: new Proxy(f.provider, { get(target, prop) { if (prop === 'getLogs') return async () => { throw new Error('connection reset'); }; const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; } }), contracts: { hook: f.hook.target, airdrop: airdrop.target, holder: holder.target, flywheel: flywheel.target }, batchSize: 100 });
  await assert.rejects(broken.sync(), /connection reset/);
  assert.equal(broken.batchSize, 100);
});

test('stock pair assets are priced from the factory feed, else the test stock\'s own reference feed', async t => {
  const f = await v2Fixture(t);
  // The factory's launch feed (approvePricedQuote), for a stock with no fixed approval.
  const stock = await f.deploy(v4Art('MockIssuerStock')), feed = await f.deploy(v4Art('MockUsdFeed'), 250n * 10n ** 8n);
  await (await f.factory.connect(f.owner).approvePricedQuote(stock.target, feed.target, 4 * 86_400)).wait();
  assert.equal(await stockUsd(f.provider, f.factory.target, stock.target), 250);
  // No feed anywhere: no price, never a guess.
  assert.equal(await stockUsd(f.provider, f.factory.target, f.usdc.target), null);
  // A stale answer (older than four days) is refused.
  await (await feed.set(250n * 10n ** 8n, Math.floor(Date.now() / 1000) - 5 * 86_400, 2, 2)).wait();
  assert.equal(await stockUsd(f.provider, f.factory.target, stock.target), null);
});

test('rewards service: a failing RPC is swapped for the next one; a test stock without a feed uses its round test price', () => {
  const made = [], net = { key: 'base-sepolia', name: 'Base Sepolia', chainId: 84532, nativeCurrency: { symbol: 'ETH' }, rpcUrl: 'https://a.example', rpcFallbacks: ['https://b.example'],
    v2: { shared: { hook: '0x' + '1'.repeat(40), airdrop: '0x' + '2'.repeat(40), holder: '0x' + '3'.repeat(40), flywheel: '0x' + '4'.repeat(40), block: 1 } } };
  const logs = [], service = new V2RewardsService({ networks: [net], providerFactory: url => { made.push(url); return { url }; }, log: l => logs.push(l), oracles: {} });
  const e = service.entries[0];
  assert.deepEqual([made, e.index.provider.url], [['https://a.example'], 'https://a.example']);
  service.failover(e); service.failover(e);
  assert.equal(e.index.provider.url, 'https://a.example', 'two failures: still the first RPC');
  service.failover(e);
  assert.equal(e.index.provider.url, 'https://b.example'); assert.match(logs.at(-1), /v2_rewards_rpc_failover/);
  const stock = '0x' + '5'.repeat(40);
  const assets = service.summary({}, undefined, () => [{ pair: 'xstock', quoteAddress: stock, quoteSymbol: 'tNVDAon', quoteDecimals: 18 }]).chains[0].assets;
  assert.equal(assets[stock].usd, 180, 'the round test price');
  service.entries[0].prices.set(stock, { usd: 200, at: Date.now() });
  assert.equal(service.summary({}, undefined, () => [{ pair: 'xstock', quoteAddress: stock, quoteSymbol: 'tNVDAon', quoteDecimals: 18 }]).chains[0].assets[stock].usd, 200, 'a live feed wins');
});
