// Token images are stored at 1500 × 500 (Malik, 5 November 2026): an uploaded logo of any shape is fitted whole into
// that frame, centred over a blurred, dimmed copy of itself, so no part of it is cropped. Square icons across the site
// show the frame's centre, which for a square logo is the whole logo.
export const TOKEN_IMAGE = Object.freeze({ width: 1500, height: 500 });

/** The largest rectangle with the source's aspect ratio inside the frame, centred: the image is shown whole. */
export function containRect(sourceWidth, sourceHeight, width = TOKEN_IMAGE.width, height = TOKEN_IMAGE.height) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('The image has no size.');
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = Math.max(1, Math.round(sourceWidth * scale)), h = Math.max(1, Math.round(sourceHeight * scale));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** The smallest rectangle with the source's aspect ratio covering the frame, centred (for the blurred fill). */
export function coverRect(sourceWidth, sourceHeight, width = TOKEN_IMAGE.width, height = TOKEN_IMAGE.height) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('The image has no size.');
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const w = Math.round(sourceWidth * scale), h = Math.round(sourceHeight * scale);
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** Bytes encoded by a base64 data URL. */
export const dataUrlBytes = url => { const b64 = url.slice(url.indexOf(',') + 1), pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0; return b64.length / 4 * 3 - pad; };

/**
 * Fits an uploaded image (a data URL) into 1500 × 500 without cropping and returns the result as a data URL: WebP
 * where the browser can encode it, else PNG, else JPEG, whichever first fits in `maxBytes`. Animated GIFs are
 * returned unchanged, because redrawing would keep only their first frame.
 */
export async function fitTokenImage(dataUrl, { maxBytes, doc = globalThis.document } = {}) {
  if (/^data:image\/gif[;,]/.test(dataUrl)) return { url: dataUrl, fitted: false };
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { throw new Error('This image could not be decoded. Try a PNG or JPG.'); }
  const { width, height } = TOKEN_IMAGE;
  const canvas = doc.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const fit = containRect(img.naturalWidth, img.naturalHeight);
  if (fit.w < width || fit.h < height) {
    // The space around the image: the same image, covering the frame, blurred and dimmed. The blur reaches past the
    // edges, so the fill is drawn a little larger than the frame to keep its borders from fading out.
    const fill = coverRect(img.naturalWidth, img.naturalHeight), bleed = 80;
    ctx.filter = 'blur(36px) brightness(0.55) saturate(1.1)';
    ctx.drawImage(img, fill.x - bleed, fill.y - bleed, fill.w + 2 * bleed, fill.h + 2 * bleed);
    ctx.filter = 'none';
  }
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  for (const [type, quality] of [['image/webp', 0.92], ['image/png'], ['image/jpeg', 0.9], ['image/jpeg', 0.75]]) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type};`) && (!maxBytes || dataUrlBytes(url) <= maxBytes)) return { url, fitted: true };
  }
  throw new Error('The fitted image is too large. Try a simpler image.');
}
