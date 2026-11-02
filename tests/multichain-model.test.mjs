// A network gets Model 10 (DEX graduation) exactly when its public DEX is enabled; the rest keep the beta curve.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/browser-modules.mjs';
import { testnets } from '../packages/core/networks.mjs';
import { testnetDexes } from '../packages/core/uniswap.mjs';
import { DEX_MODEL, BETA_MODEL } from '../packages/core/curve-model.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');

const store = new Map();
globalThis.localStorage ??= { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const publicDexes = Object.fromEntries(Object.entries(testnetDexes).filter(([, d]) => d.enabled));
function walletOn(key, netPatch = {}) {
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, { net: { ...testnets.find(n => n.key === key), ...netPatch }, config: { publicDexes, publicDex: testnetDexes['base-sepolia'], contracts: { atomicFactory: { name: 'atomic' }, dexFactory: { name: 'dex' }, legacyFactory: { name: 'legacy' }, dexCurve: { name: 'dexCurve' }, legacyCurve: { name: 'legacyCurve' } } } });
  return w;
}

test('Ethereum Sepolia (Uniswap v3), BNB Testnet (PancakeSwap v3) and Robinhood testnet (Elpida test deployment of Uniswap v3) use Model 10', () => {
  const eth = walletOn('ethereum-sepolia');
  assert.equal(eth.dex.name, 'Uniswap v3'); assert.equal(eth.dex.routerVersion, 2);
  assert.equal(eth.model, DEX_MODEL); assert.equal(eth.artifacts.factory.name, 'atomic'); assert.equal(eth.artifacts.curve.name, 'dexCurve');
  const bnb = walletOn('bnb-testnet');
  assert.equal(bnb.dex.name, 'PancakeSwap v3'); assert.equal(bnb.dex.routerVersion, 1, 'PancakeSwap periphery router layout');
  assert.equal(bnb.model, DEX_MODEL); assert.equal(bnb.artifacts.factory.name, 'atomic');
  const rh = walletOn('robinhood-testnet');
  assert.equal(rh.dex.name, 'Uniswap v3 (Elpida test deployment)'); assert.equal(rh.dex.routerVersion, 2);
  assert.equal(rh.model, DEX_MODEL); assert.equal(rh.artifacts.factory.name, 'atomic');
  assert.equal(walletOn('base-sepolia').model, DEX_MODEL);
});

test('an older beta launchpad saved in this browser does not block setting up the Model 10 one', () => {
  const eth = walletOn('ethereum-sepolia', { shared: null }); // as before the team launchpad was pinned
  localStorage.setItem(`elpida:${BETA_MODEL}:deployment:11155111`, JSON.stringify({ factory: '0x' + '1'.repeat(40), model: BETA_MODEL }));
  assert.equal(eth.deployment, null, 'the beta record is kept but not used, so deploy() is allowed');
  localStorage.setItem(`elpida:${DEX_MODEL}:deployment:11155111`, JSON.stringify({ factory: '0x' + '2'.repeat(40), model: DEX_MODEL }));
  assert.equal(eth.deployment.factory, '0x' + '2'.repeat(40));
});

test('Ethereum Sepolia uses the pinned team launchpad, which takes precedence over a launchpad saved in this browser', () => {
  const eth = walletOn('ethereum-sepolia');
  localStorage.setItem(`elpida:${DEX_MODEL}:deployment:11155111`, JSON.stringify({ factory: '0x' + '3'.repeat(40), model: DEX_MODEL, launchFeaturesVersion: 1, partnerTiersVersion: 1 }));
  const d = eth.deployment;
  assert.equal(d.factory, '0x37Ca07Eb2A14E30051DbF78e4adCc7fBc1430477'); assert.equal(d.shared, true); assert.equal(d.block, 12048655); assert.equal(d.model, DEX_MODEL);
  assert.equal(d.partnerTiersVersion, 1, 'the pinned launchpad has the partner registry');
  assert.deepEqual(eth.net.legacy.map(l => l.factory), ['0x5aA283B8B12786314e76ac4E977B1E9275b407f6', '0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2'], 'the earlier launchpads stay indexed');
  assert.equal(d.reviewFixesVersion, 1, 'the pinned launchpad has the security review fixes');
});

test('BNB tokens are labelled PancakeSwap v3 wherever the DEX is named (indexer and wallet)', async () => {
  const { EvmIndexer } = await import('../packages/indexer/evm-indexer.mjs');
  const contracts = Object.fromEntries(['factory', 'curve', 'pool', 'token', 'dexPool'].map(n => [n, { abi: [] }]));
  const index = new EvmIndexer({ provider: {}, factory: '0x' + '1'.repeat(40), contracts, dexName: testnetDexes['bnb-testnet'].name });
  assert.equal(index.dexName, 'PancakeSwap v3'); await index.close?.();
  const plain = new EvmIndexer({ provider: {}, factory: '0x' + '1'.repeat(40), contracts });
  assert.equal(plain.dexName, 'Uniswap v3', 'default unchanged'); await plain.close?.();
  assert.equal(walletOn('bnb-testnet').dex.name, 'PancakeSwap v3');
});

test('BNB Testnet uses its pinned reviewed launchpad through publicnode; the earlier one stays indexed', () => {
  const bnb = walletOn('bnb-testnet');
  assert.equal(bnb.deployment.factory, '0x4CabA05067171DbA4B840aDae1e652B8279dE499'); assert.equal(bnb.deployment.shared, true);
  assert.equal(bnb.deployment.block, 140398704); assert.equal(bnb.deployment.model, DEX_MODEL);
  assert.deepEqual(bnb.net.legacy.map(l => l.factory), ['0x5795b25C7fA37638eEacd29848522f8Cd48a1156', '0x8c48b67E3D541955ec5DCf99629c4270aC6CfBbE'], 'the earlier launchpads stay indexed');
  assert.equal(bnb.net.rpcUrl, 'https://bsc-testnet-rpc.publicnode.com');
});

test('every EVM testnet pins a partner-tier launchpad and keeps the earlier ones indexed', async () => {
  const { testnets } = await import('../packages/core/networks.mjs');
  for (const n of testnets.filter(n => n.kind === 'evm' && n.shared)) {
    assert.equal(n.shared.partnerTiersVersion, 1, n.key);
    assert.equal(n.shared.reviewFixesVersion, 1, `${n.key}: the pinned launchpad has the security review fixes`);
    assert.ok((n.legacy ?? []).length >= 1, `${n.key} keeps its earlier launchpad indexed`);
    assert.ok(!(n.legacy ?? []).some(l => l.factory.toLowerCase() === n.shared.factory.toLowerCase()), `${n.key}: shared is not also legacy`);
  }
});
