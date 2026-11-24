// Robinhood stock tokens on Robinhood Chain: the fallback icon (display only). The route in server.mjs shows Ondo's icon
// for the same company first (Robinhood's own logo is its feather for every token); this serves Robinhood's otherwise.
// Robinhood publishes each token's logo at
// cdn.robinhood.com/ncw_assets/logos/<lowercase token address>.png (the logoUrl field of api.robinhood.com/rhj/assets,
// checked 24 November 2026). The server fetches it once, checks it is a small PNG, JPEG or WebP and serves it from this
// origin (/api/public/robinhood-stock-icon/<address>.png), only for tokens on the verified Robinhood Chain stock list, so
// pages never call Robinhood directly and the route cannot be used to fetch anything else.
import { sniffImage } from './coinbase-stocks.mjs';

export const ROBINHOOD_LOGO_BASE = 'https://cdn.robinhood.com/ncw_assets/logos/';
const ICON_RETRY_MS = 3_600_000, MAX_ICON_BYTES = 1024 * 1024;

export const robinhoodLogoUrl = address => /^0x[0-9a-fA-F]{40}$/.test(String(address ?? '')) ? `${ROBINHOOD_LOGO_BASE}${String(address).toLowerCase()}.png` : null;

/** `listed(address)` says whether the address is on the verified list; only those are fetched. */
export function createRobinhoodStockIcons({ fetchImpl = fetch, now = () => Date.now(), log = () => {}, listed = () => false } = {}) {
  const icons = new Map(), failed = new Map();
  async function icon(address) {
    const a = String(address ?? '').toLowerCase(), url = robinhoodLogoUrl(a);
    if (!url || !listed(a)) return null;
    if (icons.has(a)) return icons.get(a);
    if ((failed.get(a) ?? 0) > now()) return null;
    try {
      const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer()), type = sniffImage(bytes);
      if (bytes.length < 64 || bytes.length > MAX_ICON_BYTES || !type) throw new Error('not a PNG, JPEG or WebP');
      const value = { bytes, type }; icons.set(a, value); return value;
    } catch (e) { failed.set(a, now() + ICON_RETRY_MS); log({ event: 'robinhood_stock_icon_unavailable', address: a, error: String(e?.message ?? e).slice(0, 80) }); return null; }
  }
  return { icon };
}
