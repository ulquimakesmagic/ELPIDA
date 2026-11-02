// Ondo stock catalog and token icons (display only). The launch picker lists stocks by symbol, company and type, with
// the issuer's own token icon. The catalog comes from the public asset list Ondo's app uses
// (https://app.ondo.finance/api/v2/assets), validated and cached on the data volume; icons come from Ondo's CDN
// (https://cdn.ondo.finance/tokens/logos/<symbol>_160x160.png), checked to be a small PNG and cached. Both are served
// from this origin, so the CSP stays 'self'. Nothing here decides what can be launched: only a launchpad's approved
// quotes are selectable, and live stock capabilities stay off until verified (docs/ONDO_PAIRING.md).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CATALOG_URL = 'https://app.ondo.finance/api/v2/assets';
export const ICON_BASE = 'https://cdn.ondo.finance/tokens/logos/';
const REFRESH_MS = 6 * 3_600_000, ICON_RETRY_MS = 3_600_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024, MAX_ICON_BYTES = 256 * 1024, MIN_ASSETS = 50;
const SYMBOL = /^[A-Z0-9.]{1,12}on$/, TICKER = /^[A-Z0-9.]{1,12}$/;
const TYPES = new Map([['stock', 'Stock'], ['etf', 'ETF'], ['closed-end-fund-cef', 'Fund']]);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reads a response body with a byte cap; throws past it. */
async function capped(response, max) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > max) throw new Error('response too large');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new Error('response too large'); } chunks.push(value); }
  return Buffer.concat(chunks);
}

/** Validates Ondo's asset list into display records. Throws when the shape is not what we expect. */
export function parseCatalog(json) {
  if (!json || !Array.isArray(json.assets)) throw new Error('unexpected catalog shape');
  const out = [], seen = new Set();
  for (const a of json.assets) {
    if (!a || typeof a.symbol !== 'string' || !SYMBOL.test(a.symbol) || seen.has(a.symbol)) continue;
    const ticker = typeof a.ticker === 'string' && TICKER.test(a.ticker) ? a.ticker : a.symbol.slice(0, -2);
    const name = typeof a.assetName === 'string' ? a.assetName.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) : '';
    const tag = Array.isArray(a.tags) ? a.tags.find(t => t?.categorySlug === 'instrument-type') : null;
    const type = TYPES.get(String(tag?.tagSlug ?? '')) ?? 'Stock';
    seen.add(a.symbol);
    out.push({ symbol: a.symbol, ticker, name: name || ticker, type, paused: a.isTradingPaused === true });
  }
  if (out.length < MIN_ASSETS) throw new Error(`catalog too small (${out.length})`);
  return out.sort((x, y) => x.symbol.localeCompare(y.symbol));
}

export function createStockCatalog({ dataDir, fetchImpl = fetch, now = () => Date.now(), log = () => {}, autoRefresh = true } = {}) {
  const catalogFile = dataDir ? join(dataDir, 'stock-catalog.json') : null, iconDir = dataDir ? join(dataDir, 'stock-icons') : null;
  let state = { source: CATALOG_URL, fetchedAt: null, assets: [] }, timer = null, refreshing = null;
  const failedIcons = new Map();
  if (catalogFile && existsSync(catalogFile)) { try { const saved = JSON.parse(readFileSync(catalogFile, 'utf8')); if (Array.isArray(saved.assets)) state = saved; } catch { /* a bad cache is refetched */ } }
  const known = () => new Set(state.assets.map(a => a.symbol));

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await fetchImpl(CATALOG_URL, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const assets = parseCatalog(JSON.parse((await capped(response, MAX_CATALOG_BYTES)).toString('utf8')));
        state = { source: CATALOG_URL, fetchedAt: new Date(now()).toISOString(), assets };
        if (catalogFile) { mkdirSync(dataDir, { recursive: true }); writeFileSync(catalogFile + '.tmp', JSON.stringify(state)); renameSync(catalogFile + '.tmp', catalogFile); }
        log({ event: 'stock_catalog_refreshed', count: assets.length });
      } catch (error) { log({ event: 'stock_catalog_unavailable', error: String(error.message).slice(0, 120) }); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  /** PNG bytes of a stock's issuer icon, or null. Only symbols in the catalog are fetched, and only from Ondo's CDN. */
  async function icon(symbol) {
    if (!SYMBOL.test(String(symbol)) || !known().has(symbol)) return null;
    const file = iconDir ? join(iconDir, `${symbol}.png`) : null;
    if (file && existsSync(file)) { try { return readFileSync(file); } catch { /* refetch */ } }
    if ((failedIcons.get(symbol) ?? 0) > now()) return null;
    try {
      const response = await fetchImpl(`${ICON_BASE}${symbol.toLowerCase()}_160x160.png`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !/^image\/png\b/.test(response.headers.get('content-type') ?? '')) throw new Error(`HTTP ${response.status}`);
      const bytes = await capped(response, MAX_ICON_BYTES);
      if (bytes.length < 64 || !PNG.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
      if (file) { mkdirSync(iconDir, { recursive: true }); writeFileSync(file + '.tmp', bytes); renameSync(file + '.tmp', file); }
      return bytes;
    } catch (error) { failedIcons.set(symbol, now() + ICON_RETRY_MS); log({ event: 'stock_icon_unavailable', symbol, error: String(error.message).slice(0, 80) }); return null; }
  }

  return {
    refresh, icon,
    summary: () => ({ provider: 'ondo', source: state.source, fetchedAt: state.fetchedAt, count: state.assets.length, assets: state.assets,
      note: 'Display catalog only. A stock can be paired only where a launchpad has approved it; live stock pairing is off until verified.' }),
    start() {
      if (!autoRefresh) return this;
      const stale = !state.fetchedAt || now() - Date.parse(state.fetchedAt) > REFRESH_MS;
      if (stale) refresh();
      timer = setInterval(refresh, REFRESH_MS); timer.unref?.();
      return this;
    },
    close() { if (timer) clearInterval(timer); },
  };
}
