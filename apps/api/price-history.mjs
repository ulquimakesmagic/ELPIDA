// Hourly USD prices for analytics (14 Nov 2026). Dollar figures for fees and revenue are valued at the hour of each trade
// or payout, not at today's price: a fee paid when ETH was $3,000 stays $3,000-worth even if ETH later moves. One row per
// network, asset and hour, kept two years. Before this table existed there is no history; those amounts are valued at the
// current price and the API says so ("revalued").
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR = 3600, KEEP_SECONDS = 2 * 365 * 86400;
/** How far back an hourly price may be used for a later moment (a gap in recording, e.g. a restart). */
export const PRICE_HISTORY_MAX_GAP = 6 * HOUR;

export class PriceHistory {
  constructor({ path = ':memory:', now = () => Math.floor(Date.now() / 1000) } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS prices (network TEXT NOT NULL, asset TEXT NOT NULL, hour INTEGER NOT NULL, usd REAL NOT NULL, source TEXT, PRIMARY KEY(network, asset, hour));`);
  }

  /**
   * Records this hour's prices. `entries`: [{ network, asset ('native' or a lower-case address), usd, source }]; prices
   * that are not positive finite numbers are skipped. A later call in the same hour replaces that hour's value.
   */
  record(entries, at = this.now()) {
    const hour = Math.floor(at / HOUR) * HOUR, put = this.db.prepare('INSERT OR REPLACE INTO prices(network, asset, hour, usd, source) VALUES(?,?,?,?,?)');
    let written = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of entries ?? []) {
        const usd = Number(e?.usd);
        if (!e?.network || !e?.asset || !Number.isFinite(usd) || usd <= 0) continue;
        put.run(String(e.network), String(e.asset).toLowerCase(), hour, usd, e.source ? String(e.source).slice(0, 120) : null); written++;
      }
      this.db.prepare('DELETE FROM prices WHERE hour < ?').run(hour - KEEP_SECONDS);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return written;
  }

  /** The USD price of `asset` on `network` at `timestamp` (the latest hourly value at or before it, at most 6 h old), or null. */
  usdAt(network, asset, timestamp) {
    const hour = Math.floor(Number(timestamp) / HOUR) * HOUR;
    const row = this.db.prepare('SELECT usd, hour FROM prices WHERE network = ? AND asset = ? AND hour <= ? ORDER BY hour DESC LIMIT 1').get(String(network), String(asset).toLowerCase(), hour);
    return row && hour - row.hour <= PRICE_HISTORY_MAX_GAP ? row.usd : null;
  }

  /** The first hour recorded (null before any): figures before it are valued at the current price. */
  since() { return this.db.prepare('SELECT MIN(hour) AS h FROM prices').get()?.h ?? null; }

  close() { this.db.close(); }
}

/**
 * The entries to record from the price keeper's snapshot ({ network: { usd, status, … } }) and the listed tokens' quote
 * assets (each token's own USD reference, e.g. a stock pair's feed or USDC parity).
 */
export function priceEntries(snapshot, tokens = [], usdReferenceFor = () => null, now = Math.floor(Date.now() / 1000)) {
  const out = new Map();
  for (const [network, ref] of Object.entries(snapshot ?? {})) {
    const usd = Number(ref?.usd ?? ref?.price);
    if (Number.isFinite(usd) && usd > 0) out.set(`${network}:native`, { network, asset: 'native', usd, source: ref?.source ?? 'price keeper' });
  }
  for (const t of tokens) {
    if (!t?.network || t.pair === 'native') continue;
    const asset = String(t.quoteAddress ?? t.quoteMint ?? '').toLowerCase(); if (!asset) continue;
    const key = `${t.network}:${asset}`; if (out.has(key)) continue;
    const ref = usdReferenceFor(t, snapshot?.[t.network] ?? null, now);
    if (ref?.status === 'fresh' && Number(ref.usd) > 0) out.set(key, { network: t.network, asset, usd: Number(ref.usd), source: ref.source ?? null });
  }
  return [...out.values()];
}
