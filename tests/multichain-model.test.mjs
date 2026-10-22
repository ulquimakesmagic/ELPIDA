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

test('Ethereum Sepolia now uses Uniswap v3 and Model 10; BNB and Robinhood keep the beta curve until enabled', () => {
  const eth = walletOn('ethereum-sepolia');
  assert.equal(eth.dex.name, 'Uniswap v3'); assert.equal(eth.dex.routerVersion, 2);
  assert.equal(eth.model, DEX_MODEL); assert.equal(eth.artifacts.factory.name, 'atomic'); assert.equal(eth.artifacts.curve.name, 'dexCurve');
  for (const key of ['bnb-testnet', 'robinhood-testnet']) {
    const w = walletOn(key);
    assert.equal(w.dex, null, key); assert.equal(w.model, BETA_MODEL, key); assert.equal(w.artifacts.factory.name, 'legacy', key);
  }
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
  localStorage.setItem(`elpida:${DEX_MODEL}:deployment:11155111`, JSON.stringify({ factory: '0x' + '3'.repeat(40), model: DEX_MODEL, launchFeaturesVersion: 1 }));
  const d = eth.deployment;
  assert.equal(d.factory, '0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2'); assert.equal(d.shared, true); assert.equal(d.block, 11972040); assert.equal(d.model, DEX_MODEL);
});
