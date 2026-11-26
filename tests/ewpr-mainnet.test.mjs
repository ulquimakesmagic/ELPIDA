// EWPR on mainnet (22 November 2026): ELPIDA_V2_DISTRIBUTIONS=airdrop runs only the trader airdrop; the keeper converts
// on the chain's payout DEX and uses the plan's USDC decimals; a recorded USDC airdrop distributor reaches the keeper;
// without one, mainnet posts nothing (USDC only); per-token verification runs only with an explorer key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { EVM_MAINNETS, mainnetNetwork } from '../packages/core/mainnets.mjs';
import { configuredV2Keeper } from '../apps/api/v2-keeper.mjs';
import { productionGuard } from '../apps/api/production-guard.mjs';

const a = n => '0x' + n.toString(16).padStart(40, '0');
const keeper = Wallet.createRandom();
const read = k => ({ ...JSON.parse(readFileSync(new URL(`../deployments/plans/${k}.json`, import.meta.url), 'utf8')), treasury: a(0xa1), keeper: keeper.address, guardian: a(0xa3) });
const record = (chainId, extra = {}) => ({ chainId, status: 'ready', block: 1, contracts: { create2: a(1), factory: a(2), airdrop: a(3), holder: a(4), flywheel: a(5), hook: a(6), router: a(7), ...extra } });
const net = (key, extra) => { const t = EVM_MAINNETS.find(n => n.key === key); return mainnetNetwork(t, record(t.chainId, extra), read(key)).net; };
const make = (nets, env = {}) => configuredV2Keeper({ env: { ELPIDA_V2_KEEPER_KEY: keeper.privateKey, ...env }, networks: nets, indexFor: () => null, prices: () => ({}), path: ':memory:' });

test('airdrop mode: fees, the EWPR airdrop and creator rewards; holder rewards and the flywheel keep accruing', () => {
  const k = make([net('base-mainnet')], { ELPIDA_V2_DISTRIBUTIONS: 'airdrop' });
  assert.equal(k.distributions, 'airdrop');
  assert.deepEqual(k.jobs(), ['fees', 'airdrop', 'creator']);
  const v = make([net('base-mainnet')], { ELPIDA_V2_DISTRIBUTIONS: 'airdrop', ELPIDA_EXPLORER_API_KEY: 'K' });
  assert.deepEqual(v.jobs(), ['fees', 'airdrop', 'creator', 'verify'], 'token verification with an explorer key');
  assert.deepEqual(make([net('base-mainnet')], { ELPIDA_EXPLORER_API_KEY: 'K', ELPIDA_TOKEN_VERIFY: 'off' }).jobs(), ['fees', 'creator']);
  const g = productionGuard({ env: { ELPIDA_V2_DISTRIBUTIONS: 'airdrop' }, evm: { mode: 'mainnet', networks: [net('base-mainnet')], skipped: [] } });
  assert.ok(g.warnings.some(w => w.code === 'distributions_airdrop'));
});

test('each mainnet converts on its own DEX into the plan\'s USDC with the plan\'s decimals', () => {
  const k = make([net('base-mainnet'), net('bnb-mainnet')]);
  const [b, n] = k.workers;
  assert.equal(b.dex.name, 'Uniswap v3'); assert.equal(b.dex.routerVersion, 2); assert.equal(b.usdcDecimals, 6);
  assert.equal(n.dex.name, 'PancakeSwap v3'); assert.equal(n.dex.routerVersion, 1, 'PancakeSwap\'s router takes a deadline'); assert.equal(n.usdcDecimals, 18, 'BNB Chain USDC has 18 decimals');
  assert.equal(n.usdc, read('bnb-mainnet').usdc);
});

test('a recorded USDC airdrop distributor reaches the keeper; without one mainnet posts nothing', async () => {
  const withIt = net('bnb-mainnet', { usdcAirdrop: a(9) });
  assert.equal(withIt.v2.shared.usdcAirdrop, a(9));
  assert.equal(make([withIt]).workers[0].deployment.usdcAirdrop, a(9));
  const k = make([net('bnb-mainnet')], { ELPIDA_V2_DISTRIBUTIONS: 'airdrop' }), w = k.workers[0];
  w.index = () => ({ listings: () => [] });
  await k.airdrop(w);
  const run = k.status().chains[0].runs.find(r => r.job === 'airdrop');
  assert.equal(run.status, 'waiting');
});

test('public keeper status hides detailed error and conversion notes from stored runs', async t => {
  const keeper = make([net('base-mainnet')]);
  t.after(() => keeper.close());
  const rpcError = 'Provider refused https://rpc.example/v2/synthetic-test-credential';
  keeper.db.prepare('INSERT INTO v2k_runs(chain,job,at,status,detail) VALUES(?,?,?,?,?)').run(
    'base-mainnet', 'airdrop', 100, 'failed', JSON.stringify({ error: rpcError, skipped: { [a(1)]: rpcError } }),
  );
  const [operatorJob] = keeper.status().chains[0].jobs;
  assert.match(operatorJob.note, /synthetic-test-credential/);
  const [publicJob] = keeper.status({ includeDetails: false }).chains[0].jobs;
  assert.deepEqual(publicJob, { job: 'airdrop', at: 100, status: 'failed', error: null, note: null });
});

test('the dashboard: this month\'s progress for a wallet, from indexed trades, as an estimate', () => {
  const k = make([net('base-mainnet', { usdcAirdrop: a(9) })], { ELPIDA_V2_DISTRIBUTIONS: 'airdrop' }), w = k.workers[0];
  const now = Date.UTC(2026, 10, 22, 12) / 1000; k.now = () => now;
  const usdc = w.usdc.toLowerCase(), me = a(0xbeef), other = a(0xcafe);
  const trade = (account, day, value) => ({ account, timestamp: Date.UTC(2026, 10, day, 10) / 1000, feeRaw: String(Math.round(value * 0.0125 * 1e6)), quoteAmount: String(value), token: a(0x77), asset: usdc, quoteDecimals: 6 });
  const trades = [];
  for (const day of [3, 5, 10, 12, 16]) for (let i = 0; i < 2; i++) { trades.push(trade(me, day, 50)); trades.push(trade(other, day, 500)); }
  trades.push(trade(w.deployment.flywheel, 12, 10_000));
  w.index = () => ({ listings: () => [{ address: a(0x77), creator: a(0xc0) }], transfersOf: () => [], tradesBetween: (from, to) => trades.filter(t => t.timestamp >= from && t.timestamp < to) });
  const s = k.ewprStatus(me), c = s.chains[0];
  assert.equal(s.model, 'ewpr-1'); assert.equal(s.estimate, true); assert.equal(c.payout, 'USDC');
  assert.equal(c.participants, 2, 'the flywheel vault is not a trader');
  assert.equal(c.you.days, 5); assert.equal(c.you.trades, 10); assert.equal(c.you.eligible, true);
  assert.equal(c.you.multiplier, (9_600 + 200 * 5) / 12_000);
  assert.ok(c.you.share > 0 && c.you.share < 0.5, 'less fees, smaller share, but more than pro rata');
  assert.ok(c.you.share > 50 / 550, 'F^0.8 favours the smaller trader against plain pro rata');
  assert.equal(k.ewprStatus(a(0xdead)).chains[0].you, null);
});

test('stock-pair fees count: the keeper prices a real stock from its approved feed, fresh only', () => {
  const stock = a(0x5106);
  const k = configuredV2Keeper({ env: { ELPIDA_V2_KEEPER_KEY: keeper.privateKey }, networks: [net('bnb-mainnet')], indexFor: () => null, prices: () => ({}), path: ':memory:', stockUsd: (key, asset) => (key === 'bnb-mainnet' && asset === stock ? 345.5 : null) });
  const w = k.workers[0];
  assert.equal(w.usdPerUnit(stock), 345.5);
  assert.equal(w.usdPerUnit(a(0x5107)), null, 'an unknown asset stays unpriced (counts $0)');
  assert.equal(w.usdPerUnit(w.usdc), 1);
});

test('V2.3 replaces V2.0: one keeper worker, on the V2.3 launchpad', () => {
  const t = EVM_MAINNETS.find(n => n.key === 'bnb-mainnet');
  const v23 = { record: { chainId: 56, status: 'ready', block: 2, model: 'v2.3-hook', contracts: { factory: a(21), airdrop: a(23), hook: a(26), router: a(27) } }, plan: { ...read('bnb-mainnet'), model: 'v2.3-hook' } };
  const n = mainnetNetwork(t, record(56), read('bnb-mainnet'), v23).net, calls = [];
  const k = configuredV2Keeper({ env: { ELPIDA_V2_KEEPER_KEY: keeper.privateKey }, networks: [n], indexFor: (key, f) => { calls.push([key, f]); return null; }, prices: () => ({}), path: ':memory:' });
  assert.deepEqual(k.workers.map(w => w.chain), ['bnb-mainnet-v23']);
  assert.equal(k.workers[0].deployment.holder, undefined); assert.equal(k.workers[0].deployment.flywheel, undefined);
  k.workers.forEach(w => w.index()); assert.deepEqual(calls, [['bnb-mainnet', a(21)]]);
});

test('BNB Chain wallet funders come from NodeReal MegaNode when its key is set (Etherscan has no free BNB tier)', async () => {
  const { funderFor, megaNodeFunder } = await import('../apps/api/v2-keeper.mjs');
  const calls = [], wallet = a(0xbeef), funder = a(0xf00d);
  const fetchImpl = async (url, opts) => { calls.push([url, opts?.body ? JSON.parse(opts.body) : null]); return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { transfers: [{ from: funder.toUpperCase().replace('0X', '0x'), to: wallet, value: '0x1' }] } }) }; };
  assert.equal(await megaNodeFunder('KEY', fetchImpl)(wallet), funder);
  assert.equal(calls[0][0], 'https://bsc-mainnet.nodereal.io/v1/KEY'); assert.equal(calls[0][1].method, 'nr_getAssetTransfers'); assert.equal(calls[0][1].params[0].toAddress, wallet);
  assert.equal(funderFor(56, {}), null);
  assert.ok(funderFor(56, { ELPIDA_MEGANODE_API_KEY: 'K' })); assert.ok(funderFor(56, { ELPIDA_EXPLORER_API_KEY: 'E' }));
  calls.length = 0; await funderFor(56, { ELPIDA_MEGANODE_API_KEY: 'K', ELPIDA_EXPLORER_API_KEY: 'E' }, fetchImpl)(wallet); assert.match(calls[0][0], /nodereal/, 'MegaNode first on BNB');
  calls.length = 0; await funderFor(8453, { ELPIDA_MEGANODE_API_KEY: 'K', ELPIDA_EXPLORER_API_KEY: 'E' }, async u => { calls.push([u]); return { json: async () => ({ result: [] }) }; })(wallet); assert.match(calls[0][0], /etherscan/, 'Etherscan on Base');
});

test('wallet funder lookups return null when nothing funded the wallet, and read every reply shape', async () => {
  const { megaNodeFunder, etherscanFunder } = await import('../apps/api/v2-keeper.mjs');
  const wallet = a(0xbeef), funder = a(0xf00d), reply = body => async () => ({ json: async () => body });
  // MegaNode: transfers list, a bare array, an error reply, transfers to someone else or without a sender
  assert.equal(await megaNodeFunder('K', reply({ result: [{ from: funder, to: wallet }] }))(wallet), funder, 'a bare array result');
  assert.equal(await megaNodeFunder('K', reply({ error: { message: 'limit' } }))(wallet), null, 'an error reply');
  assert.equal(await megaNodeFunder('K', reply({ result: { transfers: [{ from: funder, to: a(1) }, { to: wallet }] } }))(wallet), null, 'no transfer in with a sender');
  assert.equal(await megaNodeFunder('K', reply({ result: 'nope' }))(wallet), null, 'a non-list result');
  // Etherscan: zero-value transfers in do not count, nor does an error string
  assert.equal(await etherscanFunder(8453, 'E', reply({ result: [{ from: funder, to: wallet, value: '0' }, { from: a(2), to: wallet, value: '5' }] }))(wallet), a(2));
  assert.equal(await etherscanFunder(8453, 'E', reply({ result: [{ from: funder, to: wallet }] }))(wallet), null, 'no value field');
  assert.equal(await etherscanFunder(56, 'E', reply({ status: '0', result: 'Free API access is not supported for this chain' }))(wallet), null);
});
