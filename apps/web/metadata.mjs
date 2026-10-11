// Shared by the form, local API and browser-wallet flow. Metadata is off-chain.
export const metadataFields = ['description', 'image', 'website', 'twitter', 'telegram', 'discord'];
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
    if (field === 'image' && value.startsWith('data:')) {
      const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match || match[2].length > 349528 || match[2].length % 4) throw new Error('Use a PNG, JPG or WebP logo under 256 KB.');
      // Reject disguised SVG/HTML payloads before exposing them as images.
      const prefix = atob(match[2].slice(0, 32));
      const valid = match[1] === 'png' ? prefix.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? prefix.startsWith('\xff\xd8\xff') : prefix.startsWith('RIFF') && prefix.slice(8,12) === 'WEBP';
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
