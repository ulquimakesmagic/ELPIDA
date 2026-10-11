import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMetadata, MAX_IMAGE_BYTES, MAX_METADATA_REQUEST_BYTES} from '../apps/web/metadata.mjs';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('metadata preserves Unicode descriptions, raster uploads and official community links', () => {
  const metadata=normalizeMetadata({description:'  A garden 🌱\nFor everyone  ',image:png,website:'https://example.com',twitter:'https://x.com/garden',telegram:'https://t.me/garden',discord:'https://discord.gg/garden'});
  assert.equal(metadata.description,'A garden 🌱\nFor everyone'); assert.equal(metadata.image,png);
  assert.equal(metadata.website,'https://example.com/'); assert.equal(metadata.twitter,'https://x.com/garden');
  assert.equal(normalizeMetadata({}).image,'');
});
test('all supported image signatures and exact 5 MB uploads share one validation policy', () => {
  const signatures = {png:'\x89PNG\r\n\x1a\n',jpeg:'\xff\xd8\xff',webp:'RIFF\x00\x00\x00\x00WEBP',gif:'GIF89a',bmp:'BM',avif:'\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avif'};
  for (const [type,signature] of Object.entries(signatures)) {
    const image = `data:image/${type};base64,${Buffer.from(signature,'latin1').toString('base64')}`;
    assert.equal(normalizeMetadata({image}).image,image);
    assert.throws(()=>normalizeMetadata({image:`data:image/${type};base64,${Buffer.from('<script>').toString('base64')}`}));
  }
  const bytes=Buffer.alloc(MAX_IMAGE_BYTES);Buffer.from(png.split(',')[1],'base64').copy(bytes);
  const image='data:image/png;base64,'+bytes.toString('base64');
  assert.equal(normalizeMetadata({image}).image,image);
  assert.ok(Buffer.byteLength(JSON.stringify({image,name:'Boundary',symbol:'BOUND',description:'x'.repeat(1000)}))<MAX_METADATA_REQUEST_BYTES);
  const tooLarge='data:image/png;base64,'+Buffer.concat([bytes,Buffer.from([0])]).toString('base64');
  assert.throws(()=>normalizeMetadata({image:tooLarge}),/5 MB/);
});
test('metadata rejects executable links, disguised image payloads, oversized data and misleading social hosts', () => {
  for (const body of [{website:'javascript:alert(1)'},{image:'data:image/svg+xml;base64,PHN2Zy8+'},{image:'data:image/png;base64,PHNjcmlwdD4='},{website:'https://name:password@example.com'},{twitter:'https://x.com.evil.example/garden'},{description:'x'.repeat(1001)},{image:'data:image/png;base64,'+'a'.repeat(349532)},{telegram:123}]) assert.throws(()=>normalizeMetadata(body));
});
