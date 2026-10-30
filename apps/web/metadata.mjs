// Shared by the form, local API and browser-wallet flow. Metadata is off-chain.
export const metadataFields = ['description', 'image', 'website', 'twitter', 'telegram', 'discord'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
export const IMAGE_FORMATS = 'PNG, JPG, WebP, GIF, AVIF or BMP';
// JSON carries base64 (4/3 of the original bytes), plus token/reward metadata.
export const MAX_METADATA_REQUEST_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;
export function normalizeMetadata(body = {}) {
  const result = {};
  for (const field of metadataFields) {
    if (body[field] != null && typeof body[field] !== 'string') throw new Error(`Check the ${field} field.`);
    const value = (body[field] ?? '').trim();
    if (field === 'description') {
      if (value.length > 1000) throw new Error('Description must be 1,000 characters or fewer.');
      result[field] = value; continue;
    }
    if (!value) { result[field] = ''; continue; }
    if (field === 'image' && /^\/api\/content\/(b[a-z2-7]{30,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(value)) { result[field]=value; continue; }
    // The server's own logo route for EVM tokens whose details were signed by the creator (no IPFS document).
    if (field === 'image' && /^\/api\/wallet-logo\/[a-z0-9-]+\/0x[0-9a-fA-F]{40}$/.test(value)) { result[field]=value; continue; }
    if (field === 'image' && value.startsWith('data:')) {
      const match = value.match(/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,([A-Za-z0-9+/]+={0,2})$/);
      const padding = match ? (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) : 0;
      if (!match || match[2].length % 4 || match[2].length / 4 * 3 - padding > MAX_IMAGE_BYTES) throw new Error(`Use a ${IMAGE_FORMATS} logo up to 5 MB.`);
      // Reject disguised SVG/HTML payloads before exposing them as images.
      const prefix = atob(match[2].slice(0, 96));
      const signatures = {
        png: prefix.startsWith('\x89PNG\r\n\x1a\n'),
        jpeg: prefix.startsWith('\xff\xd8\xff'),
        webp: prefix.startsWith('RIFF') && prefix.slice(8,12) === 'WEBP',
        gif: prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a'),
        bmp: prefix.startsWith('BM'),
        avif: prefix.slice(4,8) === 'ftyp' && [prefix.slice(8,12), ...Array.from({length:Math.max(0,Math.floor((prefix.length-16)/4))},(_,i)=>prefix.slice(16+i*4,20+i*4))].some(brand=>brand==='avif'||brand==='avis'),
      };
      const valid = signatures[match[1]];
      if (!valid) throw new Error('The logo contents do not match its image type.');
      result[field] = value; continue;
    }
    if (value.length > 2048) throw new Error(`${field} URL is too long.`);
    let url;
    try { url = new URL(value); } catch { throw new Error(`Enter a full HTTPS URL for ${field}.`); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error(`Use a public HTTPS URL for ${field}.`);
    const host = url.hostname.toLowerCase();
    const allowed = {twitter:['x.com','twitter.com','www.x.com','www.twitter.com'],telegram:['t.me','telegram.me'],discord:['discord.gg','discord.com']};
    if (allowed[field] && !allowed[field].includes(host)) throw new Error(`Use an official ${field === 'twitter' ? 'X / Twitter' : field} link.`);
    result[field] = url.href;
  }
  return result;
}

/**
 * Token details for display: what this browser saved at launch, over what the server indexed, field by field. A blank
 * or missing saved field never hides the server's value (a fresh device has nothing saved; an old save may lack the
 * image). Anything that fails validation is ignored rather than shown.
 */
export function withSavedMetadata(server, saved) {
  let base = {}, mine = {};
  try { base = normalizeMetadata(server ?? {}); } catch { base = {}; }
  try { mine = saved ? normalizeMetadata(saved) : {}; } catch { mine = {}; }
  const out = { ...(server && typeof server === 'object' ? server : {}), ...base };
  for (const [key, value] of Object.entries(mine)) if (value) out[key] = value;
  return out;
}
