// Token logo thumbnails (PageSpeed, 14 Nov 2026: a 2248×2225, 1.4 MB logo was served whole to an 89×50 avatar).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Thumbnails, thumbWidth, THUMB_WIDTHS } from '../apps/api/thumbnails.mjs';
import { rawCid } from '../apps/api/metadata-store.mjs';

const bigPng = () => sharp({ create: { width: 2248, height: 2225, channels: 4, background: { r: 180, g: 220, b: 40, alpha: 1 } } })
  .composite([{ input: Buffer.from('<svg width="2248" height="2225"><circle cx="1124" cy="1112" r="900" fill="#123"/></svg>') }]).png({ compressionLevel: 0 }).toBuffer();

test('only listed widths are made: a request picks the smallest listed size at least that wide', () => {
  assert.deepEqual(THUMB_WIDTHS, [64, 128, 256, 512]);
  assert.equal(thumbWidth('164'), 256); assert.equal(thumbWidth('128'), 128); assert.equal(thumbWidth('9000'), 512); assert.equal(thumbWidth('1'), 64);
  for (const bad of [null, '', '0', '-5', 'abc']) assert.equal(thumbWidth(bad), null);
});

test('a large logo becomes a small WebP, kept on disk and reused; the original is untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-thumbs-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = await bigPng(), cid = rawCid(png), record = { type: 'image/png', data: png.toString('base64') };
  let loads = 0;
  const thumbs = new Thumbnails({ dir, loadSharp: async () => { loads++; return sharp; } });
  const out = await thumbs.get(cid, record, 256);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp'); assert.ok(meta.width <= 256 && meta.height <= 256);
  assert.ok(out.length * 50 < png.length, `${out.length} bytes instead of ${png.length}`);
  assert.deepEqual(readdirSync(dir), [`${cid}-256.webp`]);
  const again = new Thumbnails({ dir, loadSharp: async () => { loads++; return sharp; } });
  assert.deepEqual(await again.get(cid, record, 256), out, 'read back from disk');
  assert.equal(loads, 1, 'the image library is not even loaded for a cached thumbnail');
  assert.equal(record.data, png.toString('base64'));
});

test('no thumbnail (so the original is served) for SVG, non-images, undecodable bytes, small images, odd sizes or ids', async () => {
  const thumbs = new Thumbnails({ dir: null, loadSharp: async () => sharp });
  const png = await bigPng(), cid = rawCid(png);
  assert.equal(await thumbs.get(cid, { type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, 128), null);
  assert.equal(await thumbs.get(cid, { type: 'application/json', data: Buffer.from('{}').toString('base64') }, 128), null);
  assert.equal(await thumbs.get('../../etc', { type: 'image/png', data: png.toString('base64') }, 128), null);
  assert.equal(await thumbs.get(cid, { type: 'image/png', data: png.toString('base64') }, 100), null, 'only listed widths');
  const junk = Buffer.from('not an image at all');
  assert.equal(await thumbs.get(rawCid(junk), { type: 'image/png', data: junk.toString('base64') }, 128), null);
  const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).webp({ quality: 50 }).toBuffer();
  assert.equal(await thumbs.get(rawCid(tiny), { type: 'image/webp', data: tiny.toString('base64') }, 512), null, 'not smaller than the original');
});

test('avatars ask for a thumbnail of stored logos only, at twice their displayed size', async () => {
  globalThis.document ??= undefined;
  const { thumbnailUrl } = await import('../apps/web/ui.mjs').catch(() => ({}));
  if (!thumbnailUrl) return; // ui.mjs needs a DOM in some environments; the server side is covered above
  assert.equal(thumbnailUrl('/api/content/bafkreiabc', 82), '/api/content/bafkreiabc?w=164');
  assert.equal(thumbnailUrl('/api/content/bafkreiabc', 400), '/api/content/bafkreiabc?w=512');
  assert.equal(thumbnailUrl('https://example.com/logo.png', 82), 'https://example.com/logo.png');
  assert.equal(thumbnailUrl('/api/wallet-logo/base/0x0000000000000000000000000000000000000001', 82), '/api/wallet-logo/base/0x0000000000000000000000000000000000000001');
});

test('logos Elpida served under its old Railway address load from this site; other hosts are left alone', async () => {
  const { thumbnailUrl, ownImagePath } = await import('../apps/web/ui.mjs');
  assert.equal(ownImagePath('https://elpida-production.up.railway.app/assets/brand/icon-512.png'), '/assets/brand/icon-512.png');
  assert.equal(thumbnailUrl('https://elpida-production.up.railway.app/api/content/bafkreiabc', 82), '/api/content/bafkreiabc?w=164');
  assert.equal(ownImagePath('https://other.up.railway.app/assets/x.png'), 'https://other.up.railway.app/assets/x.png');
  assert.equal(ownImagePath('http://elpida-production.up.railway.app/assets/x.png'), 'http://elpida-production.up.railway.app/assets/x.png');
  assert.equal(ownImagePath('https://elpida-production.up.railway.app/admin'), 'https://elpida-production.up.railway.app/admin');
});
