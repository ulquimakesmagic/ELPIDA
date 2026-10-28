import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOndoAssetPage } from '../packages/core/ondo-assets.mjs';
import { discoverOndoAssets } from '../scripts/ondo-assets.mjs';

const source = 'https://app.ondo.finance/assets/nvdaon';
const row = { symbol: 'NVDAon', underlyingName: 'NVIDIA Corporation Common Stock', supportedNetworks: [{ network: 'ETHEREUM', chainId: 1, address: '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee', decimals: 18 }] };
const page = data => `<a href="https://example.com/0x${'ff'.repeat(20)}">partner</a><script>self.__next_f.push(${JSON.stringify([1, `34:${JSON.stringify(data)}\n`])})</script>`;
const parse = (data = row, override = {}) => parseOndoAssetPage({ html: page(data), source, symbol: 'NVDAon', accessed: '2026-10-28', ...override });

test('issuer parsing ignores partner addresses and leaves semantics and capabilities unverified', () => {
  const [asset] = parse(['$', 'component', null, row]);
  assert.equal(asset.address, row.supportedNetworks[0].address);
  assert.equal(asset.network, 'ethereum');
  assert.equal(asset.verified, false);
  assert.equal(asset.model, null);
  assert.equal(asset.feedIncludesMultiplier, null);
  assert.throws(() => parse(row, { html: page({ partner: row.supportedNetworks[0] }) }), /No structured/);
});

test('issuer parsing rejects spoofed sources, wrong identities and conflicting records', () => {
  for (const bad of ['https://app.ondo.finance.evil.test/assets/nvdaon', `${source}?redirect=1`, 'http://app.ondo.finance/assets/nvdaon']) assert.throws(() => parse(row, { source: bad }), /official Ondo/);
  assert.throws(() => parse({ ...row, symbol: 'TSLAon' }), /No structured/);
  for (const changes of [{ chainId: 56 }, { address: 'NVDAon' }, { decimals: -1 }, { network: 'BASE', chainId: 8453 }]) {
    assert.throws(() => parse({ ...row, supportedNetworks: [{ ...row.supportedNetworks[0], ...changes }] }));
  }
  assert.throws(() => parse([row, { ...row, supportedNetworks: [{ ...row.supportedNetworks[0], decimals: 6 }] }]), /Conflicting/);
  assert.throws(() => parse({ ...row, supportedNetworks: [...row.supportedNetworks, ...row.supportedNetworks] }), /Duplicate/);
});

test('discovery refuses redirects, HTTP failures and duplicate asset identities', async () => {
  const fetchPage = async (url, options) => { assert.equal(url, source); assert.equal(options.redirect, 'error'); return { ok: true, text: async () => page(row) }; };
  const manifest = await discoverOndoAssets(['NVDAon'], { fetchPage, accessed: '2026-10-28' });
  assert.equal(manifest.assets.length, 1);
  await assert.rejects(discoverOndoAssets(['NVDAon', 'NVDAon'], { fetchPage }), /Duplicate/);
  await assert.rejects(discoverOndoAssets(['NVDAon'], { fetchPage: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(discoverOndoAssets(['../secret'], { fetchPage }), /symbol/);
});
