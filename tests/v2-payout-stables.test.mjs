// Stablecoin payouts on every EVM test chain (Malik, 11 November): BNB Chain testnet converts through PancakeSwap v3,
// whose router takes a deadline; Robinhood Chain pays USDG, not USDC; and chains without an official test stablecoin
// use Elpida's labelled, no-value test dollar (tUSDC / tUSDG), set up from the operator panel with a small pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, parseEther, solidityPacked, ZeroAddress } from 'ethers';
import './helpers/browser-modules.mjs';
import { v2Fixture, mined, v4Art } from './helpers/v2-fixture.mjs';
import { v4Artifacts } from '../apps/api/v4-artifacts.mjs';
import { compileContracts } from '../scripts/compile.mjs';
import { payoutStable, payoutTicker } from '../packages/core/payout-stable.mjs';
import { v3Artifacts } from '../packages/core/uniswap.mjs';

const swapRouterV1 = JSON.parse(readFileSync(new URL('../node_modules/@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json', import.meta.url), 'utf8'));

test('the payout stablecoin per network: pinned first, else USDC; Robinhood pays USDG', () => {
  assert.deepEqual(payoutStable({ key: 'base-sepolia' }, { 'base-sepolia': { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' } }), { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', decimals: 6, test: false });
  assert.equal(payoutStable({ key: 'bnb-testnet' }, { 'bnb-testnet': {} }), null);
  assert.deepEqual(payoutStable({ key: 'robinhood-testnet', payoutStable: { address: '0x1', symbol: 'tUSDG', decimals: 6, test: true } }, { 'robinhood-testnet': { usdc: '0x2' } }), { address: '0x1', symbol: 'tUSDG', decimals: 6, test: true });
  assert.equal(payoutTicker({ key: 'robinhood-testnet' }), 'USDG'); assert.equal(payoutTicker({ key: 'bnb-testnet' }), 'USDC');
});

test('a PancakeSwap-style router (exactInput with a deadline) converts too', async t => {
  const f = await v2Fixture(t, { vaults: true, convert: true }), v3 = f.contracts.v3, keeper = f.signers[4];
  const routerV1 = await f.deploy(swapRouterV1, v3.factory.target, v3.weth.target);
  const d = await f.deploy(v4Art('ElpidaV2UsdcDistributor'), f.addresses[4], await f.contracts.holder.period(), await f.contracts.holder.genesis(), 'holder-rewards-usdc', f.usdc.target, routerV1.target, v3.weth.target, f.contracts.holder.target, true);
  assert.equal(await d.routerDeadline(), true);
  await mined(f.signers[0].sendTransaction({ to: d.target, value: parseEther('0.1') }));
  const path = solidityPacked(['address', 'uint24', 'address'], [v3.weth.target, 3000, f.usdc.target]);
  await mined(d.connect(keeper).convert(ZeroAddress, parseEther('0.1'), 240n * 10n ** 6n, path));
  const got = await f.usdc.balanceOf(d.target);
  assert.ok(got >= 240n * 10n ** 6n && got < 251n * 10n ** 6n, `about $250 (${got})`);
  // The same router through the deadline-less call shape fails: the flag must match the router.
  const wrong = await f.deploy(v4Art('ElpidaV2UsdcDistributor'), f.addresses[4], await f.contracts.holder.period(), await f.contracts.holder.genesis(), 'holder-rewards-usdc', f.usdc.target, routerV1.target, v3.weth.target, f.contracts.holder.target, false);
  await mined(f.signers[0].sendTransaction({ to: wrong.target, value: parseEther('0.1') }));
  await assert.rejects(wrong.connect(keeper).convert(ZeroAddress, parseEther('0.1'), 1n, path));
});

test('the operator sets up a labelled test USDG with a pool, then deploys the payout distributors on it', async t => {
  const store = new Map(), oldStorage = globalThis.localStorage, oldFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.fetch = async url => { if (String(url) === '/api/v4-artifacts') return { ok: true, json: async () => JSON.parse(JSON.stringify(v4Artifacts())) }; throw new Error('unexpected fetch ' + url); };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.fetch = oldFetch; });
  const f = await v2Fixture(t, { vaults: true, convert: true }), v3 = f.contracts.v3, operator = f.signers[2];
  const art = compileContracts()['contracts/evm/testnet/ElpidaTestDollar.sol'].ElpidaTestDollar;
  const { setupTestPayoutStable, payoutStableFor, deployV2UsdcDistributors } = await import('../apps/web/v2-launchpad.mjs');
  const shared = { factory: f.factory.target, hook: f.hook.target, router: f.router.target, airdrop: f.contracts.airdrop.target, holder: f.contracts.holder.target, flywheel: f.contracts.flywheel.target, block: 0 };
  const net = { key: 'robinhood-testnet', name: 'Local Robinhood', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.manager.target }, v2: { shared } };
  const wallet = { net, provider: f.provider, signer: operator, address: f.addresses[2], onProgress() {}, oracle: { usdc: null }, dex: { ...v3.config, routerVersion: 2 },
    config: { contracts: { testDollar: { abi: art.abi, bytecode: '0x' + art.evm.bytecode.object } }, v2Keeper: { address: f.addresses[4], active: true } },
    async oraclePrice() { return { usd: 2500 }; }, async wait(p) { const tx = await p; return { tx, receipt: await tx.wait() }; } };
  assert.equal(payoutStableFor(wallet), null);
  await assert.rejects(deployV2UsdcDistributors(wallet), /no USDG for payouts yet/);
  await assert.rejects(setupTestPayoutStable(wallet, { nativeAmount: '0.5' }), /up to 0\.1/);
  const { record, message } = await setupTestPayoutStable(wallet, { nativeAmount: '0.01' });
  assert.equal(record.symbol, 'tUSDG'); assert.match(message, /Elpida Test USDG/);
  const dollar = new Contract(record.address, art.abi, f.provider);
  assert.equal(await dollar.name(), 'Elpida Test USDG (no value)'); assert.equal(await dollar.decimals(), 6n);
  // A 1% full-range pool at $2,500: 0.01 ETH against 25 tUSDG; a quote for 0.001 ETH comes back near $2.50.
  const pool = await v3.factory.getPool(record.address, v3.weth.target, 10000);
  assert.notEqual(pool, ZeroAddress);
  const quoter = new Contract(v3.quoter.target, v3Artifacts.quoter.abi, f.provider);
  const [out] = await quoter.quoteExactInput.staticCall(solidityPacked(['address', 'uint24', 'address'], [v3.weth.target, 10000, record.address]), parseEther('0.001'));
  assert.ok(out > 2_000_000n && out < 2_500_000n, `quote ${out}`);
  assert.deepEqual({ ...payoutStableFor(wallet) }, { ...record, pinned: false });
  await assert.rejects(setupTestPayoutStable(wallet), /already has a payout stablecoin/);
  const deployed = await deployV2UsdcDistributors(wallet);
  assert.match(deployed.message, /tUSDG payout distributors are deployed/);
  const d = new Contract(deployed.record.airdrop, v4Art('ElpidaV2UsdcDistributor').abi, f.provider);
  assert.equal((await d.usdc()).toLowerCase(), record.address.toLowerCase());
  assert.equal(await d.routerDeadline(), false);
  // A PancakeSwap-style DEX (routerVersion 1) gets routerDeadline = true.
  store.delete('elpida:v2:usdc-distributors:31337');
  const pancake = await deployV2UsdcDistributors({ ...wallet, dex: { ...wallet.dex, routerVersion: 1 } });
  assert.equal(await new Contract(pancake.record.holder, v4Art('ElpidaV2UsdcDistributor').abi, f.provider).routerDeadline(), true);
});
