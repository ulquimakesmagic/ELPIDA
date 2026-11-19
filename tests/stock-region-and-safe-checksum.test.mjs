// Ondo (19 November 2026): stock pairs must be geofenced from prohibited regions such as the US. And the Safe
// Transaction Builder checksum, so batch files load without the "changed properties" warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { id } from 'ethers';
import './helpers/browser-modules.mjs';
const pairs = await import('../packages/core/pairs.mjs');
const { safeBatch, serializeForChecksum, withSafeChecksum } = await import('../apps/web/safe-batch.mjs');

test('stockRegionStatus blocks the US, Canada, sanctioned countries and Tor, and nothing else by default', () => {
  for (const c of ['US', 'us', 'PR', 'CA', 'IR', 'KP', 'RU', 'T1']) assert.equal(pairs.stockRegionStatus(c).allowed, false, c);
  for (const c of ['NG', 'GB', 'DE', 'SG', 'XX', '', null, undefined, 'USA', '1']) assert.equal(pairs.stockRegionStatus(c).allowed, true, String(c));
  assert.match(pairs.stockRegionStatus('US').reason, /not available in your region/);
  assert.equal(pairs.stockRegionStatus('NG', ['NG']).allowed, false);
  assert.deepEqual(pairs.blockedCountriesFrom(' us, ca ,bad,'), ['US', 'CA']);
  assert.equal(pairs.blockedCountriesFrom(''), null);
});

test('the browser region gate: chain rule first, then the region; stock approvals ignore the region', () => {
  pairs.setStockRegion({ allowed: false, reason: 'Blocked here.' });
  assert.equal(pairs.stockRegionOff(), 'Blocked here.');
  assert.equal(pairs.stockPairsBlocked(8453), 'Blocked here.');
  assert.equal(pairs.stockPairsOff(8453), null);
  pairs.setStockRegion(undefined); assert.equal(pairs.stockRegionOff(), 'Blocked here.');
  pairs.setStockRegion({ allowed: true }); assert.equal(pairs.stockPairsBlocked(8453), null);
});

test('the server sends the region with /api/config, and the launch flow, wallet and token page use it', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../apps/api/server.mjs'), /stockRegion: stockRegionStatus\(req\.headers\['cf-ipcountry'\]/);
  assert.match(read('../apps/web/app.mjs'), /setStockRegion\(config\.stockRegion\)/);
  for (const f of ['launch-flow.mjs', 'wallet.mjs']) assert.doesNotMatch(read(`../apps/web/${f}`), /stockPairsOff\(/, f);
  assert.match(read('../apps/web/token-page.mjs'), /side === 'buy' && token\.pair === 'xstock' && stockRegionOff\(\)/);
});

test('Safe checksum: keys sorted, values with trailing commas, meta.name left out', () => {
  assert.equal(serializeForChecksum({ b: 1, a: [2, undefined] }), '{["a","b"][2,null],1,}');
  assert.equal(serializeForChecksum({}), '{[]}');
  const tx = [{ to: '0x' + '1'.repeat(40), data: '0x12' }];
  const one = safeBatch({ chainId: 8453, safe: '0x' + '2'.repeat(40), name: 'A', description: 'd', transactions: tx, now: 1, keccak: id });
  const two = safeBatch({ chainId: 8453, safe: '0x' + '2'.repeat(40), name: 'B', description: 'd', transactions: tx, now: 1, keccak: id });
  assert.match(one.meta.checksum, /^0x[0-9a-f]{64}$/);
  assert.equal(one.meta.checksum, two.meta.checksum);
  const { checksum, ...meta } = one.meta;
  assert.equal(checksum, id(serializeForChecksum({ ...one, meta: { ...meta, name: null } })));
  assert.equal(withSafeChecksum(one, id).meta.checksum, checksum);
  assert.notEqual(safeBatch({ chainId: 1, safe: '0x' + '2'.repeat(40), name: 'A', description: 'd', transactions: tx, now: 1, keccak: id }).meta.checksum, checksum);
  assert.equal(safeBatch({ chainId: 1, safe: '0x' + '2'.repeat(40), name: 'A', description: 'd', transactions: tx }).meta.checksum, undefined);
});
