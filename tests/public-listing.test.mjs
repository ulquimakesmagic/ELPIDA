// A listing must never carry image bytes. One token with an inline data: image made every listing 1.1 MB, and the
// client fetches that listing for every network on every refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMetadata } from '../apps/api/public-indexer.mjs';

const entry = image => ({ net: { key: 'base-sepolia' }, metadata: new Map([['0xabc', { name: 'Hope', image }]]) });
const token = { address: '0xabc' };

test('an inline image becomes the logo URL', () => {
  const metadata = publicMetadata(entry('data:image/png;base64,iVBORw0KGgo='), token);
  assert.equal(metadata.image, '/api/wallet-logo/base-sepolia/0xabc');
  assert.equal(metadata.imageInline, true);
  assert.equal(metadata.name, 'Hope', 'the rest of the details survive');
});

test('a hosted image is left alone', () => {
  const metadata = publicMetadata(entry('/api/content/bafkreigh2akiscaildcqabsyg3dfr6'), token);
  assert.equal(metadata.image, '/api/content/bafkreigh2akiscaildcqabsyg3dfr6');
  assert.equal(metadata.imageInline, undefined);
});

test('a token with no metadata still lists', () => {
  const metadata = publicMetadata({ net: { key: 'base-sepolia' }, metadata: new Map() }, token);
  assert.deepEqual(metadata, {});
});
