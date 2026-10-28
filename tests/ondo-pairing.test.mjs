import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTokenizedEquity, CAPABILITIES } from '../packages/core/tokenized-equity.mjs';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url)));
const address = '0x' + 'ab'.repeat(20); // Test identity only, never an Ondo contract claim.

test('Ondo is explicitly selectable without replacing existing providers or enabling Base', () => {
  const t = createTokenizedEquity(config);
  for (const network of ['ethereum', 'bnb', 'solana', 'robinhood']) {
    assert.ok(t.providersForNetwork(network).includes('ondo'));
    const view = t.describeNetwork(network, 'ondo');
    assert.equal(view.provider, 'ondo');
    assert.equal(view.assets.length, network === 'robinhood' ? 0 : 3);
    for (const a of view.assets) for (const c of CAPABILITIES) assert.equal(a.capabilities[c].enabled, false);
    assert.equal(t.describeNetwork(network).provider, config.networks[network].provider);
  }
  assert.equal(t.describeNetwork('base', 'ondo'), null);
  assert.equal(t.describeNetwork('ethereum', 'unknown'), null);
  assert.equal(t.evaluateEligibility('ondo', { country: 'NG' }).allowed, false);
});

test('Ondo lookup stays canonical, provider-specific and cannot alias mainnet assets into testnets', () => {
  const asset = { network: 'ethereum', provider: 'ondo', address, symbol: 'TESTon', decimals: 18 };
  const t = createTokenizedEquity({ ...config, assets: [...config.assets, asset] });
  assert.equal(t.getAsset('ethereum', 'ondo', address).symbol, 'TESTon');
  assert.throws(() => t.getAsset('ethereum-sepolia', 'ondo', address), /cannot be substituted/);
  assert.throws(() => t.getAsset('bnb', 'ondo', address), /not in the verified registry/);
  assert.throws(() => t.getAsset('ethereum', 'ondo', 'TESTon'), /valid token address/);
  assert.equal(t.describeNetwork('ethereum', 'xstocks').assets.some(a => a.address === address), false);
  for (const capability of CAPABILITIES) assert.equal(t.capabilityState(asset, capability).enabled, false);
  const list = t.providersForNetwork('ethereum'); list.length = 0;
  assert.ok(t.providersForNetwork('ethereum').includes('ondo'));
});

test('operator flags alone cannot activate Ondo quote reserves or graduated pools', () => {
  const env = { ELPIDA_TOKENIZED_EQUITY: '1' };
  for (const c of CAPABILITIES) env[`ELPIDA_TOKENIZED_EQUITY_ONDO_${c.replace(/[A-Z]/g, x => `_${x}`).toUpperCase()}`] = '1';
  const t = createTokenizedEquity(config, { env });
  const asset = { network: 'ethereum', provider: 'ondo', address };
  for (const c of CAPABILITIES) assert.equal(t.capabilityState(asset, c).enabled, false);
});
