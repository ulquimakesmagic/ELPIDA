// The mainnet site (ELPIDA_MODE=mainnet, 17 November 2026): a mainnet appears only once its V2 deployment record is
// ready; the server uses a private RPC; the keeper collects fees and pays creator rewards only; the production guard
// refuses a mainnet site that is not ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { EVM_MAINNETS, mainnetNetwork, serverRpcUrl } from '../packages/core/mainnets.mjs';
import { loadEvmNetworks, siteMode } from '../apps/api/evm-networks.mjs';
import { productionGuard } from '../apps/api/production-guard.mjs';
import { configuredV2Keeper } from '../apps/api/v2-keeper.mjs';
import { usdOracles } from '../packages/core/usd-oracles.mjs';
import { PriceKeeper } from '../apps/api/price-keeper.mjs';
import { evmTestnets } from '../packages/core/networks.mjs';

const base = EVM_MAINNETS.find(n => n.key === 'base-mainnet');
const a = n => '0x' + n.toString(16).padStart(40, '0');
const keeper = Wallet.createRandom();
const plan = { ...JSON.parse(readFileSync(new URL('../deployments/plans/base-mainnet.json', import.meta.url), 'utf8')), treasury: a(0xa1), keeper: keeper.address, guardian: a(0xa3) };
const record = { network: 'base-mainnet', chainId: 8453, status: 'ready', block: 38_000_000, planSha256: 'f'.repeat(64), approval: 'base-mainnet-ffffffffffffffff.json', gitCommit: 'abc1234',
  contracts: { create2: a(1), factory: a(2), airdrop: a(3), holder: a(4), flywheel: a(5), hook: a(6), router: a(7) } };

test('Base mainnet appears only from a ready deployment record, with the V2 contracts, plan addresses and deploy block', () => {
  const { net } = mainnetNetwork(base, record, plan);
  assert.equal(net.key, 'base-mainnet'); assert.equal(net.chainId, 8453); assert.equal(net.mainnet, true); assert.equal(net.enabled, true);
  assert.deepEqual(net.v2.shared, { factory: a(2), hook: a(6), router: a(7), airdrop: a(3), holder: a(4), flywheel: a(5), keeper: keeper.address, treasury: a(0xa1), block: 38_000_000, minFeeBps: 100, distributions: false });
  assert.equal(net.v4.poolManager, plan.poolManager);
  assert.deepEqual(net.usd, { feed: plan.usdFeed, usdc: plan.usdc, maxAge: 1500 });
  assert.equal(net.shared, undefined, 'no Model 10 launchpad on mainnet');
  assert.equal(net.rpcUrl, 'https://mainnet.base.org', 'browsers get the public RPC');
  assert.equal('planKey' in net, false);
  for (const [why, r, p] of [
    [/no mainnet deployment record/, null, plan],
    [/"awaiting_safe", not "ready"/, { ...record, status: 'awaiting_safe' }, plan],
    [/for chain 84532/, { ...record, chainId: 84532 }, plan],
    [/has no hook/, { ...record, contracts: { ...record.contracts, hook: null } }, plan],
    [/plan has no keeper/, record, { ...plan, keeper: null }],
    [/no deploy block/, { ...record, block: 0 }, plan],
  ]) { const out = mainnetNetwork(base, r, p); assert.equal(out.net, null); assert.match(out.reason, why); }
});

test('the server runs the testnets unless ELPIDA_MODE=mainnet, and then only ready mainnets', t => {
  const root = mkdtempSync(join(tmpdir(), 'elpida-mainnet-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deployments', 'plans'), { recursive: true });
  writeFileSync(join(root, 'deployments', 'plans', 'base-mainnet.json'), JSON.stringify(plan));
  assert.equal(siteMode({}), 'testnet'); assert.equal(siteMode({ ELPIDA_MODE: ' Mainnet ' }), 'mainnet');
  assert.equal(loadEvmNetworks({ env: {}, root }).networks, evmTestnets);
  const none = loadEvmNetworks({ env: { ELPIDA_MODE: 'mainnet' }, root });
  assert.deepEqual(none.networks, []); assert.match(none.skipped[0].reason, /no mainnet deployment record/);
  writeFileSync(join(root, 'deployments', 'base-mainnet.json'), JSON.stringify(record));
  const ready = loadEvmNetworks({ env: { ELPIDA_MODE: 'mainnet' }, root });
  assert.deepEqual(ready.networks.map(n => n.key), ['base-mainnet']);
  assert.deepEqual(ready.skipped.map(s => s.key), ['bnb-mainnet', 'robinhood-mainnet', 'ethereum-mainnet'], 'the other mainnets wait for their own records');
  assert.ok(ready.skipped.every(s => /no mainnet deployment record yet/.test(s.reason)));
  assert.ok(ready.networks.every(n => n.mainnet), 'no testnet on the mainnet site');
  writeFileSync(join(root, 'deployments', 'base-mainnet.json'), '{ not json');
  assert.match(loadEvmNetworks({ env: { ELPIDA_MODE: 'mainnet' }, root }).skipped.find(s => s.key === 'base-mainnet').reason, /could not be read/);
});

const evm = () => ({ mode: 'mainnet', networks: [mainnetNetwork(base, record, plan).net], skipped: [] });
const goodEnv = () => ({ ELPIDA_PUBLIC_URL: 'https://elpida.fun', PINATA_JWT: 'x', RAILWAY_VOLUME_MOUNT_PATH: '/data', ELPIDA_BACKUP_ENABLED: 'true', ELPIDA_BACKUP_MIRROR_S3_ENDPOINT: 'https://r2.example',
  ELPIDA_RPC_8453: 'https://base-mainnet.g.alchemy.com/v2/k', ELPIDA_V2_KEEPER_KEY: keeper.privateKey });
const disabledSolana = { key: 'solana-mainnet', mainnet: true, deployment: null, disabled: true };
const codes = r => r.errors.map(e => e.code).sort();

test('the production guard passes a ready mainnet site and names what is missing otherwise', () => {
  const ok = productionGuard({ env: goodEnv(), solana: disabledSolana, evm: evm() });
  assert.equal(ok.mainnet, true); assert.deepEqual(codes(ok), []);
  assert.equal(productionGuard({ env: goodEnv(), solana: disabledSolana, evm: { mode: 'testnet', networks: evmTestnets, skipped: [] } }).mainnet, false, 'the testnet site is not checked');
  const cases = [
    ['evm_mainnet_none', {}, { mode: 'mainnet', networks: [], skipped: [{ key: 'base-mainnet', reason: 'Base: no mainnet deployment record yet.' }] }],
    ['evm_rpc_missing', { ELPIDA_RPC_8453: undefined }],
    ['evm_rpc_invalid', { ELPIDA_RPC_8453: 'http://127.0.0.1:8545' }],
    ['keeper_missing', { ELPIDA_V2_KEEPER_KEY: undefined }],
    ['keeper_invalid', { ELPIDA_V2_KEEPER_KEY: 'words words words' }],
    ['keeper_mismatch', { ELPIDA_V2_KEEPER_KEY: Wallet.createRandom().privateKey }],
    ['distributions_on', { ELPIDA_V2_DISTRIBUTIONS: 'on' }],
    ['testnet_worker_keys', { ELPIDA_FLYWHEEL_EVM_KEY: '0x' + '1'.repeat(64) }],
    ['circle_test_funding', { CIRCLE_API_KEY: 'TEST_API_KEY:x' }],
    ['tokenized_equity_on', { ELPIDA_TOKENIZED_EQUITY: '1' }],
    ['pinning_missing', { PINATA_JWT: undefined }],
  ];
  for (const [code, change, net] of cases) {
    const env = Object.fromEntries(Object.entries({ ...goodEnv(), ...change }).filter(([, v]) => v !== undefined));
    const r = productionGuard({ env, solana: disabledSolana, evm: net ?? evm() });
    assert.deepEqual(codes(r), [code], code);
    assert.ok(!JSON.stringify(r).includes('alchemy.com/v2/k') && !JSON.stringify(r).includes(keeper.privateKey.slice(2)), 'no setting value is ever reported');
  }
  assert.deepEqual(codes(productionGuard({ env: goodEnv(), solana: { key: 'solana-devnet', mainnet: false, deployment: { programId: 'x' } }, evm: evm() })), ['solana_devnet_on_mainnet_site']);
  assert.match(productionGuard({ env: {}, evm: { mode: 'mainnet', networks: [], skipped: [{ reason: 'Base: the deployment record is "awaiting_safe", not "ready".' }] } }).errors.find(e => e.code === 'evm_mainnet_none').message, /awaiting_safe/);
});

test('on mainnet the keeper collects fees and pays creator rewards only, on the private RPC, as the plan\'s keeper', () => {
  const logs = [], net = mainnetNetwork(base, record, plan).net;
  const make = env => configuredV2Keeper({ env, networks: [net], indexFor: () => null, prices: () => ({}), path: ':memory:', publicUrl: 'https://elpida.fun', log: e => logs.push(e) });
  const k = make({ ELPIDA_V2_KEEPER_KEY: keeper.privateKey, ELPIDA_V2_DISTRIBUTIONS: 'on', ELPIDA_RPC_8453: 'https://private.example/rpc' });
  assert.equal(k.enabled, true); assert.equal(k.network, 'mainnet'); assert.equal(k.distributions, false, 'never distributes on mainnet');
  assert.deepEqual(k.jobs(), ['fees', 'creator']);
  assert.equal(k.workers[0].provider._getConnection().url, 'https://private.example/rpc');
  assert.equal(k.workers[0].usdc, plan.usdc, 'USDC from the deployment plan');
  const other = make({ ELPIDA_V2_KEEPER_KEY: Wallet.createRandom().privateKey });
  assert.equal(other.enabled, false, 'a key that is not the plan\'s keeper runs nothing');
  assert.ok(logs.some(e => e.event === 'v2_keeper_skipped' && e.chain === 'base-mainnet'));
  assert.throws(() => configuredV2Keeper({ env: { ELPIDA_V2_KEEPER_KEY: keeper.privateKey }, networks: [net, ...evmTestnets], indexFor: () => null, prices: () => ({}), path: ':memory:' }), /either test networks or mainnets/);
  k.close?.(); other.close?.();
});

test('mainnet prices come from the plan\'s Chainlink feed through the private RPC', async () => {
  const net = mainnetNetwork(base, record, plan).net;
  const oracles = usdOracles({}, [net]);
  assert.deepEqual(oracles['base-mainnet'], { feed: plan.usdFeed, usdc: plan.usdc, maxAge: 1500, available: true, source: 'Chainlink ETH / USD' });
  assert.equal(oracles['base-sepolia'].available, true, 'testnet oracles are unchanged');
  assert.equal(serverRpcUrl(net, {}), 'https://mainnet.base.org'); assert.equal(serverRpcUrl(net, { ELPIDA_RPC_8453: 'https://p.example' }), 'https://p.example');
  const urls = [], now = 1_800_000_000;
  const { AbiCoder } = await import('ethers');
  const coder = AbiCoder.defaultAbiCoder();
  const fetcher = async (url, init) => {
    urls.push(url);
    if (!init?.body) throw new Error('no Pyth here');
    return { ok: true, json: async () => [{ id: 0, result: coder.encode(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], [5n, 1811_00000000n, now - 60, now - 60, 5n]) }, { id: 1, result: coder.encode(['uint8'], [8]) }] };
  };
  const keeper = new PriceKeeper({ fetcher, now: () => now, pythApiKey: '', networks: [net], env: { ELPIDA_RPC_8453: 'https://private.example/rpc' } });
  await keeper.readOracle(net);
  assert.equal(urls[0], 'https://private.example/rpc');
  assert.equal(keeper.chainValues['base-mainnet'].usd, 1811);
});

test('BNB Chain, Robinhood Chain and Ethereum: each plan names its chain, its own dollar and price feed', () => {
  const read = k => JSON.parse(readFileSync(new URL(`../deployments/plans/${k}.json`, import.meta.url), 'utf8'));
  const want = { 'bnb-mainnet': [56, 'BNB', 'USDC', 18], 'robinhood-mainnet': [4663, 'ETH', 'USDG', 6], 'ethereum-mainnet': [1, 'ETH', 'USDC', 6] };
  for (const [key, [chainId, native, dollar, decimals]] of Object.entries(want)) {
    const template = EVM_MAINNETS.find(n => n.key === key), p = { ...read(key), keeper: keeper.address };
    assert.equal(template.chainId, chainId); assert.equal(template.nativeCurrency.symbol, native); assert.equal(p.chainId, chainId);
    const { net } = mainnetNetwork(template, { ...record, network: key, chainId }, p);
    assert.equal(net.key, key);
    assert.deepEqual(net.payoutStable, { address: p.usdc, symbol: dollar, decimals, test: false }, `${key} pays in ${dollar} with ${decimals} decimals`);
    assert.equal(usdOracles({}, [net])[key].source, `Chainlink ${native} / USD`);
    assert.equal(serverRpcUrl(net, { [`ELPIDA_RPC_${chainId}`]: 'https://p.example' }), 'https://p.example');
    for (const role of ['treasury', 'keeper', 'guardian']) assert.match(String(p[role]), /^0x[0-9a-fA-F]{40}$/, `${key} ${role}`);
  }
  assert.equal(read('robinhood-mainnet').poolManager, '0x8366a39CC670B4001A1121B8F6A443A643e40951', 'Uniswap v4 on Robinhood Chain');
  assert.equal(read('robinhood-mainnet').usdc, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG on Robinhood Chain');
});
