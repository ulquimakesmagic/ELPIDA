// One-row lease for a keeper's SQLite file (audit BE-01, 11 November 2026). Only the holder of the lease may sign:
// a second process on the same data volume (a deploy overlap, a manual run) finds the lease taken and stays idle.
// The holder renews it before every transaction it signs and stops with `lease_lost` if another process took it over
// (its lease had expired), so two processes never send from one key at once.
import { randomUUID } from 'node:crypto';

export class KeeperLease {
  /** `db`: a node:sqlite DatabaseSync; `table`: the lease table's name; `ttl`: seconds; `now`: unix seconds. */
  constructor(db, table, { ttl = 15 * 60, now = () => Math.floor(Date.now() / 1000), owner = randomUUID() } = {}) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error('lease table name');
    Object.assign(this, { db, table, ttl, now, owner });
    db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO ${table}(id, owner, expires) VALUES(1, '', 0);`);
  }

  /** Takes the lease when it is free, expired or already ours; false when another process holds it. */
  acquire() {
    const t = this.now();
    return this.db.prepare(`UPDATE ${this.table} SET owner=?, expires=? WHERE id=1 AND (expires<? OR owner=?)`).run(this.owner, t + this.ttl, t, this.owner).changes === 1;
  }

  /**
   * Before every signature: extends our lease, or takes it again if it lapsed and nobody else took it. Throws
   * `lease_lost` when another process holds it, so the two never sign at once.
   */
  renew() {
    if (!this.acquire()) throw Object.assign(new Error('lease_lost: another keeper process holds the signing lease'), { code: 'lease_lost' });
  }

  release() { this.db.prepare(`UPDATE ${this.table} SET expires=0 WHERE id=1 AND owner=?`).run(this.owner); }

  holder() { return this.db.prepare(`SELECT owner, expires FROM ${this.table} WHERE id=1`).get(); }
}

/** Error text safe for a public status route (audit BE-11): no URLs, no long hex blobs, at most 200 characters. */
export function safeError(e) {
  const text = String(e?.shortMessage ?? e?.message ?? e ?? 'error');
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/0x[0-9a-fA-F]{80,}/g, m => `${m.slice(0, 18)}…`).replace(/\s+/g, ' ').slice(0, 200);
}
