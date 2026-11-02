// Partner-tier launchpad upgrade in the site's Tools panel: a launchpad without the registry offers the new version,
// a browser's own partner-tier deployment wins over the pinned one until the team pins it, an RPC failure is never
// read as "no registry", and a saved graduation adapter is reused only if it passes the burn share to the splitter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEX_MODEL, isDexModel } from '../packages/core/curve-model.mjs';

const source = readFileSync(new URL('../apps/web/wallet.mjs', import.meta.url), 'utf8');
const getters = source.slice(source.indexOf('  get deployment()'), source.indexOf("  /** A token's own curve model:"));

function wallet({ net, saved = null, Contract = class {} }) {
  const context = { read: () => saved, deploymentKey: () => '', modelOf: () => DEX_MODEL, isDexModel, DEX_MODEL, LEGACY_DEX_MODEL: 'curve-dex-v9', Contract };
  vm.runInNewContext('class Wallet { ' + getters + ' }; globalThis.Wallet=Wallet;', context);
  const w = new context.Wallet();
  Object.assign(w, { net, model: DEX_MODEL, dex: {}, provider: {}, feeAccountingVersion: 1 });
  return w;
}
const chain = (version, failure) => class { async automaticGraduation() { return true; } async REVIEW_FIXES_VERSION() { throw { code: 'CALL_EXCEPTION', data: '0x' }; } async PARTNER_TIERS_VERSION() { if (failure) throw failure; if (version === null) throw { code: 'CALL_EXCEPTION', data: '0x' }; return BigInt(version); } };

test('a launchpad without the registry offers the partner-tier upgrade on any EVM testnet', async () => {
  for (const key of ['base-sepolia', 'ethereum-sepolia', 'bsc-testnet', 'robinhood-testnet']) {
    const w = wallet({ net: { key, chainId: 1, shared: { factory: 'old', model: DEX_MODEL } }, Contract: chain(null) });
    assert.equal(w.partnerUpgradeAvailable, false, 'not before the factory was checked');
    await w.checkLaunchFeatures({ target: 'old' });
    assert.equal(w.partnerTiersVersion, 0);
    assert.equal(w.partnerUpgradeAvailable, true, key);
  }
  const current = wallet({ net: { key: 'base-sepolia', chainId: 84532, shared: { factory: 'new', model: DEX_MODEL } }, Contract: chain(1) });
  await current.checkLaunchFeatures({ target: 'new' });
  assert.equal(current.partnerUpgradeAvailable, false);
});

test('an RPC failure is not read as a missing registry', async () => {
  const w = wallet({ net: { key: 'base-sepolia', chainId: 84532, shared: { factory: 'old', model: DEX_MODEL } }, Contract: chain(0, new Error('RPC unavailable')) });
  await assert.rejects(w.checkLaunchFeatures({ target: 'old' }), /RPC unavailable/);
  assert.equal(w.partnerUpgradeAvailable, false);
});

test('a partner-tier deployment saved in this browser wins until the team pins one', () => {
  const pinned = { factory: 'old', model: DEX_MODEL, launchFeaturesVersion: 1 }, saved = { factory: 'partner', model: DEX_MODEL, launchFeaturesVersion: 1, partnerTiersVersion: 1 };
  assert.equal(wallet({ net: { key: 'bsc-testnet', chainId: 97, shared: pinned }, saved }).deployment.factory, 'partner');
  assert.equal(wallet({ net: { key: 'bsc-testnet', chainId: 97, shared: pinned }, saved: { ...saved, partnerTiersVersion: undefined } }).deployment.factory, 'old');
  assert.equal(wallet({ net: { key: 'bsc-testnet', chainId: 97, shared: { ...pinned, factory: 'team-partner', partnerTiersVersion: 1 } }, saved }).deployment.factory, 'team-partner');
});

test('deploying records the version and reuses a saved adapter only if it supports partner tiers', () => {
  assert.match(source, /partnerTiersVersion:this\.dex\?Number\(await contract\.PARTNER_TIERS_VERSION\(\)\):undefined/);
  assert.match(source, /getCode\(saved\)!=='0x'&&await adapterHasPartnerTiers\(saved,this\.provider\)/);
  assert.match(source, /!this\.launchUpgradeAvailable && !this\.partnerUpgradeAvailable && !this\.reviewUpgradeAvailable\) throw/);
  const adapter = readFileSync(new URL('../contracts/evm/src/ElpidaV3MigrationAdapter.sol', import.meta.url), 'utf8');
  assert.match(adapter, /function PARTNER_TIERS_VERSION\(\) external pure returns\(uint256\)\{return 1;\}/);
});

test('review fixes (1 Nov): a partner-tier launchpad without them offers the upgrade; a saved reviewed deployment wins until pinned', async () => {
  const versions = (partner, review) => class { async automaticGraduation() { return true; } async PARTNER_TIERS_VERSION() { return BigInt(partner); } async REVIEW_FIXES_VERSION() { if (review === null) throw { code: 'CALL_EXCEPTION', data: '0x' }; return BigInt(review); } };
  const old = wallet({ net: { key: 'ethereum-sepolia', chainId: 11155111, shared: { factory: 'partner', model: DEX_MODEL } }, Contract: versions(1, null) });
  await old.checkLaunchFeatures({ target: 'partner' });
  assert.equal(old.reviewFixesVersion, 0);
  assert.equal(old.reviewUpgradeAvailable, true);
  assert.equal(old.partnerUpgradeAvailable, false, 'one upgrade offered at a time');
  const fixed = wallet({ net: { key: 'ethereum-sepolia', chainId: 11155111, shared: { factory: 'reviewed', model: DEX_MODEL } }, Contract: versions(1, 1) });
  await fixed.checkLaunchFeatures({ target: 'reviewed' });
  assert.equal(fixed.reviewUpgradeAvailable, false);
  const pinned = { factory: 'partner', model: DEX_MODEL, launchFeaturesVersion: 1, partnerTiersVersion: 1 }, saved = { ...pinned, factory: 'reviewed', reviewFixesVersion: 1 };
  assert.equal(wallet({ net: { key: 'bsc-testnet', chainId: 97, shared: pinned }, saved }).deployment.factory, 'reviewed');
  assert.equal(wallet({ net: { key: 'bsc-testnet', chainId: 97, shared: { ...pinned, factory: 'team-reviewed', reviewFixesVersion: 1 } }, saved }).deployment.factory, 'team-reviewed');
  assert.match(source, /await adapterHasPartnerTiers\(saved,this\.provider\)&&await adapterHasReviewFixes\(saved,this\.provider\)/);
  assert.match(source, /reviewFixesVersion:this\.dex\?Number\(await contract\.REVIEW_FIXES_VERSION\(\)\):undefined/);
});
