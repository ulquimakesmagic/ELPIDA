// Ondo Global Markets asset statuses (https://docs.ondo.finance/api-reference/status/get-asset-statuses): upcoming and
// active pauses or limits per GM token (dividends, splits, earnings, maintenance), and whether the shares multiplier
// (sValue) changes. Ondo says these pauses stop minting and redemption through Ondo only; onchain transfers carry on.
// Display only: token pages show the notice so traders know a price step is coming. Off until ONDO_API_KEY is set
// (mainnet service). The key stays on the server; nothing here returns it or puts it in a log.
export const STATUS_URL = 'https://api.gm.ondo.finance/v1/status/assets';
const REFRESH_MS = 15 * 60_000, MAX_BYTES = 2 * 1024 * 1024, MAX_EVENTS = 2000;
const SYMBOL = /^[A-Za-z0-9.]{1,16}on$/;
const MESSAGES = new Map([['cash_dividend', 'cash dividend'], ['stock_dividend', 'stock dividend'], ['stock_split', 'stock split'], ['merger', 'merger'], ['acquisition', 'acquisition'], ['spinoff', 'spin-off'], ['earnings', 'earnings'], ['maintenance', 'maintenance']]);
const iso = v => { if (typeof v !== 'string') return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** Validates Ondo's response into display records; unknown or malformed entries are dropped. Throws on the wrong shape. */
export function parseStatuses(json) {
  if (!Array.isArray(json)) throw new Error('unexpected status shape');
  const out = [];
  for (const e of json.slice(0, MAX_EVENTS)) {
    if (!e || typeof e.symbol !== 'string' || !SYMBOL.test(e.symbol)) continue;
    if (!['active', 'upcoming'].includes(e.status) || !['scheduled', 'unscheduled'].includes(e.type)) continue;
    const code = e.reason?.code, kind = code === 'ASSET_PAUSED' ? 'paused' : code === 'ASSET_LIMITED' ? 'limited' : null;
    if (!kind) continue;
    out.push({ symbol: e.symbol, status: e.status, scheduled: e.type === 'scheduled', kind,
      reason: MESSAGES.get(String(e.reason?.message ?? '')) ?? 'corporate action',
      start: iso(e.start), end: iso(e.end), sValueChanges: e.updateSharesMultiplier === true });
  }
  return out;
}

export function createOndoStatus({ apiKey = process.env.ONDO_API_KEY, fetchImpl = fetch, now = () => Date.now(), log = () => {}, autoRefresh = true } = {}) {
  const key = String(apiKey ?? '').trim();
  let state = { fetchedAt: null, events: [] }, timer = null, refreshing = null;
  async function refresh() {
    if (!key) return state;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await fetchImpl(STATUS_URL, { redirect: 'error', headers: { accept: 'application/json', 'x-api-key': key }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > MAX_BYTES) throw new Error('response too large');
        state = { fetchedAt: new Date(now()).toISOString(), events: parseStatuses(JSON.parse(text)) };
        log({ event: 'ondo_status_refreshed', count: state.events.length });
      } catch (error) {
        log({ event: 'ondo_status_failed', reason: String(error?.message ?? error).replace(/[A-Za-z0-9_-]{24,}/g, '…').slice(0, 120) });
      } finally { refreshing = null; }
      return state;
    })();
    return refreshing;
  }
  return {
    enabled: Boolean(key),
    refresh,
    start() { if (key && autoRefresh) { refresh(); timer = setInterval(refresh, REFRESH_MS); timer.unref?.(); } return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    /** Events for one symbol (or all), ended ones dropped. */
    summary(symbol = null) {
      const t = now(), events = state.events.filter(e => (!symbol || e.symbol === symbol) && !(e.end && Date.parse(e.end) < t));
      return { enabled: Boolean(key), fetchedAt: state.fetchedAt, events };
    },
  };
}
