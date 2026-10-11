import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMetadata} from '../apps/web/metadata.mjs';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('metadata preserves Unicode descriptions, raster uploads and official community links', () => {
  const metadata=normalizeMetadata({description:'  A garden 🌱\nFor everyone  ',image:png,website:'https://example.com',twitter:'https://x.com/garden',telegram:'https://t.me/garden',discord:'https://discord.gg/garden'});
  assert.equal(metadata.description,'A garden 🌱\nFor everyone'); assert.equal(metadata.image,png);
  assert.equal(metadata.website,'https://example.com/'); assert.equal(metadata.twitter,'https://x.com/garden');
  assert.equal(normalizeMetadata({}).image,'');
});
test('metadata rejects executable links, disguised image payloads, oversized data and misleading social hosts', () => {
  for (const body of [{website:'javascript:alert(1)'},{image:'data:image/svg+xml;base64,PHN2Zy8+'},{image:'data:image/png;base64,PHNjcmlwdD4='},{website:'https://name:password@example.com'},{twitter:'https://x.com.evil.example/garden'},{description:'x'.repeat(1001)},{image:'data:image/png;base64,'+'a'.repeat(349532)},{telegram:123}]) assert.throws(()=>normalizeMetadata(body));
});
