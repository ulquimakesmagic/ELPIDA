// Coinbase Tokenized Stocks on Base: names and icons for the launch picker, the reward picker and Swap (display only).
// The list comes from Coinbase's public API (https://api.coinbase.com/v1/tokenized-stocks, docs.base.org, no key),
// cached; each token's `icon_url` is fetched by the server, checked to be a small PNG, JPEG or WebP and served from
// this origin (/api/public/coinbase-stock-icon/<SYMBOL>.png), so pages never call Coinbase directly. When Coinbase has no usable icon, the
// server falls back to Ondo's icon for the same company (apps/api/server.mjs).
export const COINBASE_STOCKS_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
const REFRESH_MS = 6 * 3_600_000, ICON_RETRY_MS = 3_600_000, MAX_LIST_BYTES = 4 * 1024 * 1024, MAX_ICON_BYTES = 1024 * 1024;
const SYMBOL = /^[A-Z.]{1,8}c$/, ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]];

/** image/png, image/jpeg or image/webp from the file's first bytes, else null. */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (MAGIC[0].every((b, i) => bytes[i] === b)) return 'image/png';
  if (MAGIC[1].every((b, i) => bytes[i] === b)) return 'image/jpeg';
  if (MAGIC[2].every((b, i) => bytes[i] === b) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const clean = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '';
/** Coinbase symbols are written AAPLc; the API may give AAPLC or AAPL. */
export function coinbaseSymbol(raw) {
  const s = String(raw ?? '').trim(); if (!s) return null;
  const base = /c$/i.test(s) && s.length > 1 ? s.slice(0, -1) : s;
  const sym = `${base.toUpperCase()}c`;
  return SYMBOL.test(sym) ? sym : null;
}

/** One page of the API into display records. */
export function parseCoinbaseStocks(json) {
  if (!json || !Array.isArray(json.tokens)) throw new Error('unexpected tokenized-stocks shape');
  const out = [];
  for (const t of json.tokens) {
    const symbol = coinbaseSymbol(t?.symbol), address = String(t?.contract_address ?? '');
    if (!symbol || !ADDRESS.test(address)) continue;
    let icon = null; try { const u = new URL(String(t.icon_url ?? '')); if (u.protocol === 'https:') icon = u.href; } catch { icon = null; }
    out.push({ symbol, address: address.toLowerCase(), name: clean(t.name, 80) || symbol, icon });
  }
  return { tokens: out, next: typeof json.next_page_token === 'string' && json.next_page_token ? json.next_page_token : null };
}

export function createCoinbaseStocks({ fetchImpl = fetch, now = () => Date.now(), log = () => {}, autoRefresh = true } = {}) {
  let state = { fetchedAt: null, tokens: [] }, refreshing = null, timer = null;
  const icons = new Map(), failed = new Map();
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const all = []; let token = null;
        for (let page = 0; page < 10; page++) {
          const url = `${COINBASE_STOCKS_URL}?page_size=500${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
          const r = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const text = await r.text(); if (text.length > MAX_LIST_BYTES) throw new Error('response too large');
          const { tokens, next } = parseCoinbaseStocks(JSON.parse(text)); all.push(...tokens); token = next;
          if (!token) break;
        }
        if (all.length) state = { fetchedAt: new Date(now()).toISOString(), tokens: all };
        log({ event: 'coinbase_stocks_refreshed', count: all.length });
      } catch (e) { log({ event: 'coinbase_stocks_unavailable', error: String(e?.message ?? e).slice(0, 120) }); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function icon(symbol) {
    const t = state.tokens.find(x => x.symbol === symbol); if (!t?.icon) return null;
    if (icons.has(symbol)) return icons.get(symbol);
    if ((failed.get(symbol) ?? 0) > now()) return null;
    try {
      const r = await fetchImpl(t.icon, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      // Coinbase's CDN may label icons as binary/octet-stream, so the type is read from the bytes, not the header.
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const type = sniffImage(bytes);
      if (bytes.length < 64 || bytes.length > MAX_ICON_BYTES || !type) throw new Error(`not a PNG, JPEG or WebP (${r.headers.get('content-type') ?? 'no type'})`);
      const value = { bytes, type };
      icons.set(symbol, value); return value;
    } catch (e) { failed.set(symbol, now() + ICON_RETRY_MS); log({ event: 'coinbase_stock_icon_unavailable', symbol, error: String(e?.message ?? e).slice(0, 80) }); return null; }
  }
  return {
    refresh, icon,
    summary: () => ({ provider: 'coinbase', fetchedAt: state.fetchedAt, tokens: state.tokens.map(({ symbol, address, name, icon: i }) => ({ symbol, address, name, hasIcon: !!i })) }),
    start() { if (autoRefresh) { refresh(); timer = setInterval(refresh, REFRESH_MS); timer.unref?.(); } return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
