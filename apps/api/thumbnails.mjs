// Small WebP copies of uploaded token logos (PageSpeed, 14 Nov 2026: one launched token's 2248×2225 PNG of 1.4 MB was
// served whole to an 89×50 avatar on the home page; 2.27 MB of the page was avoidable image bytes). The Explore grid,
// lists and token page ask for `/api/content/<cid>?w=<size>` and get a resized WebP instead of the original.
//
// Sizes are a fixed set so the cache stays small and nobody can make the server render arbitrary sizes. Each thumbnail
// is made once and kept on disk (and in a small memory cache); the original is never changed and stays available
// without `w`. If an image cannot be decoded, the original is served, so a logo never disappears because of this.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const THUMB_WIDTHS = [64, 128, 256, 512];
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const CID = /^(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

/** The thumbnail width to serve for a `w` query value: the smallest listed size at least that wide, or null for the original. */
export function thumbWidth(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return THUMB_WIDTHS.find(w => w >= n) ?? THUMB_WIDTHS.at(-1);
}

export class Thumbnails {
  /**
   * @param {object} o
   * @param {string|null} o.dir  where thumbnails are kept (null: memory only, as in tests)
   * @param {() => Promise<any>} [o.loadSharp]  the image library, loaded on first use so startup does not pay for it
   * @param {number} [o.memoryEntries]  thumbnails kept in memory
   */
  constructor({ dir = null, loadSharp = async () => (await import('sharp')).default, memoryEntries = 400 } = {}) {
    this.dir = dir; this.loadSharp = loadSharp; this.memoryEntries = memoryEntries;
    this.memory = new Map(); this.pending = new Map(); this.sharp = null; this.failed = new Set();
    if (dir) mkdirSync(dir, { recursive: true });
  }

  async library() {
    if (!this.sharp) {
      const sharp = await this.loadSharp();
      // One image at a time and no libvips cache: thumbnails are rare (once per logo and size) and memory is billed.
      try { sharp.cache(false); sharp.concurrency(1); } catch { /* a stub in tests */ }
      this.sharp = sharp;
    }
    return this.sharp;
  }

  remember(key, bytes) {
    this.memory.delete(key); this.memory.set(key, bytes);
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value);
  }

  /**
   * A WebP thumbnail of `record` (the stored content: { type, data base64 }) at `width`, or null when it cannot or need
   * not be made (not an image, an SVG, already small enough, or undecodable): then the caller serves the original.
   */
  async get(cid, record, width) {
    if (!CID.test(String(cid)) || !THUMB_WIDTHS.includes(width) || !RESIZABLE.has(record?.type)) return null;
    const key = `${cid}-${width}`;
    if (this.failed.has(cid)) return null;
    const hit = this.memory.get(key);
    if (hit) { this.remember(key, hit); return hit; }
    const file = this.dir ? join(this.dir, `${key}.webp`) : null;
    if (file && existsSync(file)) { const bytes = readFileSync(file); this.remember(key, bytes); return bytes; }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      try {
        const sharp = await this.library();
        const input = Buffer.from(record.data, 'base64');
        const bytes = await sharp(input, { animated: false, limitInputPixels: 40_000_000 })
          .rotate()
          .resize({ width, height: width, fit: 'cover', withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toBuffer();
        // A thumbnail that is not smaller than the original is no help: serve the original.
        if (bytes.length >= input.length) return null;
        if (file) { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, bytes); renameSync(tmp, file); }
        this.remember(key, bytes);
        return bytes;
      } catch {
        this.failed.add(cid);
        return null;
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, job);
    return job;
  }
}
