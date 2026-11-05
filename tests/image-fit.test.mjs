// Token images are stored at 1500 × 500 with the whole upload fitted inside (never cropped). The canvas drawing runs in
// the browser; these check the geometry and the size accounting it relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_IMAGE, containRect, coverRect, dataUrlBytes } from '../apps/web/image-fit.mjs';

test('uploads of any shape are fitted whole and centred in 1500 × 500', () => {
  assert.deepEqual(TOKEN_IMAGE, { width: 1500, height: 500 });
  // A square logo fills the middle third: exactly what square icons (center crop) show.
  assert.deepEqual(containRect(1000, 1000), { x: 500, y: 0, w: 500, h: 500 });
  assert.deepEqual(containRect(3000, 1000), { x: 0, y: 0, w: 1500, h: 500 }, 'already 3:1: fills the frame');
  assert.deepEqual(containRect(4000, 1000), { x: 0, y: 63, w: 1500, h: 375 }, 'wider than 3:1: bars above and below');
  assert.deepEqual(containRect(400, 1200), { x: 667, y: 0, w: 167, h: 500 }, 'tall: centred, full height');
  for (const [w, h] of [[1, 1], [37, 991], [5000, 3], [1500, 500], [64, 64]]) {
    const r = containRect(w, h);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1500 && r.y + r.h <= 500, `${w}×${h} stays inside the frame`);
    assert.ok(Math.abs(r.w / r.h - w / h) / (w / h) < 0.02 || r.w <= 2 || r.h <= 2, `${w}×${h} keeps its shape`);
  }
  const c = coverRect(1000, 1000);
  assert.ok(c.w >= 1500 && c.h >= 500 && c.x <= 0 && c.y <= 0, 'the blurred fill covers the frame');
  assert.throws(() => containRect(0, 10), /no size/);
});

test('data URL byte counting matches the decoded size', () => {
  for (const n of [1, 2, 3, 4, 100, 1001]) {
    const url = `data:image/png;base64,${Buffer.alloc(n, 7).toString('base64')}`;
    assert.equal(dataUrlBytes(url), n);
  }
});
