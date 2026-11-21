// Dollar references for tokenized-stock pair assets, read from the feed the V2 factory itself prices launches with
// (`quoteFeeds`). Browser-safe and free of I/O: the caller supplies `read` and `now`, so the cache is testable.
//
// Why this exists: `usdReferenceFor` in pairs.mjs only knew how to value a stock pair on a *test* network (the
// explicitly simulated issuer). On mainnet it fell through to null, so every stock-paired token showed no market cap,
// no USD volume and "awaiting a price" — SPIDERMAN/AAPLon on BNB, 20 November. The chain configuration was correct all
// along; nothing was turning it into a number.

/** Version of the reference shape this module produces. */
export const STOCK_REFERENCE_VERSION = 1;

/**
 * Builds the `usdReference` a token carries, from one feed reading.
 * `maxAge` comes from the factory's own staleness window, so the label and the gate agree.
 * Returns null when the reading cannot support a dollar figure.
 */
export function stockReferenceFrom({ price, updatedAt, maxAge, source, feed = null, now = Math.floor(Date.now() / 1000) }) {
  const usd = Number(price), at = Number(updatedAt), age = now - at;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!Number.isFinite(at) || at <= 0) return null;
  // A feed stamped in the future by more than five minutes is not usable evidence.
  if (age < -300) return null;
  const window = Number(maxAge) > 0 ? Number(maxAge) : 86_400;
  const fresh = age <= window;
  return {
    status: fresh ? 'fresh' : 'stale',
    usd,
    updatedAt: at,
    maxAge: window,
    source: String(source ?? 'Tokenized-stock USD feed'),
    feed: feed ? String(feed) : null,
    version: STOCK_REFERENCE_VERSION,
  };
}

/**
 * One cache per process, keyed `network:quote` (lower case). `refresh` reads every quote it is given and keeps the
 * last good reading per (network, quote): a feed that misses one round does not blank the page for a cycle.
 */
export class StockReferences {
  /** `read(quote)` → `{ price, updatedAt, maxAge, source, feed }` or null; `now()` in seconds. */
  constructor({ read, now = () => Math.floor(Date.now() / 1000), log = () => {} } = {}) {
    this.read = read; this.now = now; this.log = log;
    this.values = new Map();
  }

  get(network, quote) {
    if (!network || !quote) return null;
    const hit = this.values.get(`${String(network).toLowerCase()}:${String(quote).toLowerCase()}`);
    return hit ? stockReferenceFrom({ ...hit, now: this.now() }) : null;
  }

  /** Reads every quote once. A failing quote keeps whatever it had; it never removes a good reading. */
  async refresh(quotes) {
    let updated = 0;
    for (const { network, quote } of quotes ?? []) {
      if (!network || !quote) continue;
      try {
        const reading = await this.read(quote, network);
        if (!reading) continue;
        this.values.set(`${String(network).toLowerCase()}:${String(quote).toLowerCase()}`, reading);
        updated++;
      } catch (error) {
        this.log(JSON.stringify({ event: 'stock_reference_failed', network, quote, error: String(error?.shortMessage ?? error?.message ?? error).slice(0, 120) }));
      }
    }
    return updated;
  }

  /** The quotes a set of listings needs priced: every pair asset that is not the native coin or USDC. */
  static quotesOf(listings, { native = null, usdc = null } = {}) {
    const seen = new Set(), out = [];
    for (const t of listings ?? []) {
      const quote = t?.quoteAddress ?? null;
      if (!quote) continue;
      const key = String(quote).toLowerCase();
      if (key === String(native ?? '').toLowerCase() || key === String(usdc ?? '').toLowerCase()) continue;
      if (seen.has(key)) continue;
      seen.add(key); out.push(quote);
    }
    return out;
  }
}
