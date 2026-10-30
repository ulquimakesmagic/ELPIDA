import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

// First-party visitor analytics for the operator panel (docs/SITE_ANALYTICS.md). Opt-in: the browser sends a page view
// only after the visitor allows analytics in the cookie banner. A page view carries a random visitor id the browser made
// when consent was given (deleted again if consent is withdrawn), a per-tab session id, the page name from a fixed list,
// the token being viewed, the chosen network, where the visit came from and a coarse device class. The server adds the
// Cloudflare country code. No IP address, user agent, wallet address or search text is stored, and ids are stored only
// as salted hashes. Consent and disclaimer choices are counted per day with no identifier at all, so the panel can show
// how many visitors declined. Rows older than RETAIN_DAYS are deleted.

export const RETAIN_DAYS = 90;
export const PAGES = ['explore', 'launch', 'portfolio', 'rewards', 'analytics', 'docs', 'partners', 'token', 'notfound'];
export const DEVICES = ['mobile', 'tablet', 'desktop', 'bot', 'unknown'];
export const PERIODS = [1, 7, 30, 90];
const MAX_VIEWS_PER_DAY = 200_000;
const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const NETWORK = /^[a-z0-9-]{1,32}$/;
const DAY_MS = 86_400_000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** A coarse device class from a user agent. Only the class is kept, never the user agent itself. */
export function deviceOf(userAgent) {
  const ua = String(userAgent ?? '');
  if (!ua) return 'unknown';
  if (/bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly/i.test(ua)) return 'bot';
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** A two-letter country from Cloudflare's CF-IPCountry header, or null. XX (unknown) and T1 (Tor) are not countries. */
export function countryOf(header) {
  const code = String(header ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

/** Where a visit came from: a ?ref= or utm_source tag, else the referring site's host. Our own host counts as none. */
export function sourceOf(source, ownHost) {
  let value = String(source ?? '').trim().toLowerCase();
  if (!value) return null;
  if (/^https?:\/\//.test(value)) { try { value = new URL(value).hostname; } catch { return null; } }
  value = value.replace(/^www\./, '').replace(/[^a-z0-9._-]/g, '').slice(0, 60);
  if (!value || (ownHost && value === String(ownHost).toLowerCase().replace(/^www\./, '').replace(/:\d+$/, ''))) return null;
  return value;
}

/** Checks one telemetry message from the browser. Returns the stored shape or throws a 400. */
export function cleanEvent(body, { networks = null, ownHost = null } = {}) {
  if (!body || typeof body !== 'object') throw fail('Invalid event.');
  if (body.kind === 'consent') {
    if (typeof body.analytics !== 'boolean') throw fail('Invalid consent choice.');
    return { kind: 'consent', value: body.analytics ? 'accepted' : 'declined' };
  }
  if (body.kind === 'disclaimer') return { kind: 'disclaimer', value: 'accepted' };
  if (body.kind !== 'view') throw fail('Unknown event.');
  if (!ID.test(String(body.visitor ?? '')) || !ID.test(String(body.session ?? ''))) throw fail('Invalid visitor.');
  if (!PAGES.includes(body.page)) throw fail('Unknown page.');
  const network = NETWORK.test(String(body.network ?? '')) && (!networks || networks.has(body.network)) ? body.network : null;
  const token = body.page === 'token' && TOKEN.test(String(body.token ?? '')) ? String(body.token) : null;
  return { kind: 'view', visitor: body.visitor, session: body.session, page: body.page, token: token && /^0x/.test(token) ? token.toLowerCase() : token, network, source: sourceOf(body.source, ownHost) };
}

export class SiteAnalytics {
  constructor({ path = ':memory:', now = () => Date.now(), retainDays = RETAIN_DAYS } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.now = now; this.retainDays = retainDays; this.prunedAt = 0;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS views(ts INTEGER NOT NULL, day TEXT NOT NULL, visitor TEXT NOT NULL, session TEXT NOT NULL, page TEXT NOT NULL, token TEXT, network TEXT, source TEXT, country TEXT, device TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS views_day ON views(day);
      CREATE TABLE IF NOT EXISTS choices(day TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day, kind, value));`);
    // The hashing salt never leaves this database, so a stored hash cannot be matched to an id seen elsewhere.
    let salt = this.db.prepare("SELECT value FROM meta WHERE key='salt'").get()?.value;
    if (!salt) { salt = randomBytes(32).toString('hex'); this.db.prepare("INSERT INTO meta(key,value) VALUES('salt',?)").run(salt); }
    this.salt = salt;
  }

  hash(id) { return createHash('sha256').update(`${this.salt}:${id}`).digest('hex').slice(0, 24); }

  /** Stores one cleaned event. `context` is what the server knows: Cloudflare's country header and the user agent. */
  record(event, { country = null, userAgent = '' } = {}) {
    const ts = this.now(), day = dayOf(ts);
    this.prune(ts);
    if (event.kind !== 'view') {
      this.db.prepare('INSERT INTO choices(day,kind,value,n) VALUES(?,?,?,1) ON CONFLICT(day,kind,value) DO UPDATE SET n=n+1').run(day, event.kind, event.value);
      return { recorded: true };
    }
    const device = deviceOf(userAgent);
    if (device === 'bot') return { recorded: false };
    if (this.db.prepare('SELECT COUNT(*) AS n FROM views WHERE day=?').get(day).n >= MAX_VIEWS_PER_DAY) return { recorded: false };
    this.db.prepare('INSERT INTO views(ts,day,visitor,session,page,token,network,source,country,device) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(ts, day, this.hash(event.visitor), this.hash(event.session), event.page, event.token, event.network, event.source, countryOf(country), device);
    return { recorded: true };
  }

  prune(ts = this.now()) {
    if (ts - this.prunedAt < 3_600_000) return;
    this.prunedAt = ts;
    const cutoff = dayOf(ts - this.retainDays * DAY_MS);
    this.db.prepare('DELETE FROM views WHERE day<?').run(cutoff);
    this.db.prepare('DELETE FROM choices WHERE day<?').run(dayOf(ts - 400 * DAY_MS));
  }

  /** The operator panel's Visitors view for the last `days` days (today included), in UTC days. */
  summary({ days = 30, label = null } = {}) {
    days = PERIODS.includes(Number(days)) ? Number(days) : 30;
    const now = this.now(), today = dayOf(now), since = dayOf(now - (days - 1) * DAY_MS);
    const totals = from => this.db.prepare('SELECT COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session) AS sessions, COUNT(*) AS pageviews FROM views WHERE day>=?').get(from);
    const top = (column, limit = 10) => this.db.prepare(`SELECT ${column} AS key, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews FROM views WHERE day>=? AND ${column} IS NOT NULL GROUP BY ${column} ORDER BY visitors DESC, pageviews DESC, key LIMIT ?`).all(since, limit).map(r => ({ ...r }));
    const byDay = new Map(this.db.prepare('SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews FROM views WHERE day>=? GROUP BY day').all(since).map(r => [r.day, r]));
    const daily = Array.from({ length: days }, (_, i) => { const day = dayOf(now - (days - 1 - i) * DAY_MS), r = byDay.get(day); return { day, visitors: r?.visitors ?? 0, pageviews: r?.pageviews ?? 0 }; });
    const choice = (kind, value) => this.db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM choices WHERE day>=? AND kind=? AND value=?').get(since, kind, value).n;
    // A visitor is "returning" if the same hashed id was seen before the period started (within the retention window).
    const returning = this.db.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM views WHERE day>=? AND visitor IN (SELECT visitor FROM views WHERE day<?)').get(since, since).n;
    const tokens = this.db.prepare('SELECT network, token, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews FROM views WHERE day>=? AND token IS NOT NULL GROUP BY network, token ORDER BY visitors DESC, pageviews DESC LIMIT 10').all(since)
      .map(r => ({ network: r.network, token: r.token, visitors: r.visitors, pageviews: r.pageviews, label: label ? safeLabel(label, r.network, r.token) : null }));
    const period = totals(since);
    return {
      days, since, today, generatedAt: now, retainDays: this.retainDays,
      totals: { today: { ...totals(today) }, d7: { ...totals(dayOf(now - 6 * DAY_MS)) }, d30: { ...totals(dayOf(now - 29 * DAY_MS)) }, period: { ...period } },
      returning: { returning, new: Math.max(0, period.visitors - returning) },
      daily, pages: top('page'), tokens, sources: top('source'), countries: top('country'), devices: top('device'), networks: top('network'),
      consent: { accepted: choice('consent', 'accepted'), declined: choice('consent', 'declined') },
      disclaimer: { accepted: choice('disclaimer', 'accepted') },
    };
  }

  close() { this.db.close(); }
}

function safeLabel(label, network, token) { try { const value = label(network, token); return value ? String(value).slice(0, 40) : null; } catch { return null; } }

/**
 * The places the entry disclaimer asks visitors to confirm they are not in, from ELPIDA_RESTRICTED_JURISDICTIONS
 * (comma separated, for example "United States, Ontario"). Empty by default: which places to list is a legal decision
 * (docs/TERMS_AND_RISK_DRAFT.md), and the disclaimer then asks about any place where using Elpida is prohibited.
 */
export function restrictedJurisdictions(setting) {
  return [...new Set(String(setting ?? '').split(',').map(s => s.replace(/[^\p{L}\p{N} .'()-]/gu, '').trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** A small per-client limiter for the telemetry endpoint. Addresses are held in memory only, never stored. */
export function telemetryLimiter({ perMinute = 60, globalPerMinute = 6000, now = () => Date.now() } = {}) {
  let window = now(), total = 0; const counts = new Map();
  return client => {
    if (now() - window >= 60_000) { window = now(); total = 0; counts.clear(); }
    const n = (counts.get(client) ?? 0) + 1; counts.set(client, n);
    if (counts.size > 50_000) counts.clear();
    return ++total > globalPerMinute || n > perMinute;
  };
}
