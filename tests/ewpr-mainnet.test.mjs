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
