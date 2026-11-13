// Terms of Use dialog, cookie consent and the operator Visitors tab: opt-in only, no IP, user agent or raw id stored,
// strict input checks, retention, and the operator-only summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SiteAnalytics, cleanEvent, deviceOf, countryOf, sourceOf, restrictedJurisdictions, telemetryLimiter, dayOf, RETAIN_DAYS } from '../apps/api/site-analytics.mjs';
import { pageOf, visitSource, termsAccepted, consentChoice, disclaimerPoints, fullDisclaimer, CONSENT_VERSION } from '../apps/web/consent.mjs';
import { termsDocument, TERMS_VERSION } from '../apps/web/terms.mjs';
import { startServer } from '../apps/api/server.mjs';

const id = n => n.toString(16).padStart(32, '0');
const view = (visitor, session, page = 'explore', extra = {}) => cleanEvent({ kind: 'view', visitor: id(visitor), session: id(session), page, ...extra });
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';

test('browser events are checked strictly; anything unexpected is refused or dropped', () => {
  assert.deepEqual(cleanEvent({ kind: 'consent', analytics: false }), { kind: 'consent', value: 'declined' });
  assert.deepEqual(cleanEvent({ kind: 'terms', accepted: true, extra: 'ignored' }), { kind: 'terms', value: 'accepted' });
  assert.deepEqual(cleanEvent({ kind: 'terms', accepted: false }), { kind: 'terms', value: 'declined' });
  assert.throws(() => cleanEvent({ kind: 'terms' }), /Invalid Terms/);
  assert.throws(() => cleanEvent({ kind: 'consent', analytics: 'yes' }), /Invalid consent/);
  assert.throws(() => cleanEvent({ kind: 'click' }), /Unknown event/);
  assert.throws(() => cleanEvent({ kind: 'view', visitor: 'wallet-0xabc', session: id(1), page: 'explore' }), /Invalid visitor/);
  assert.throws(() => cleanEvent({ kind: 'view', visitor: id(1), session: id(1), page: 'monkey' }), /Unknown page/, 'the operator panel is never a page');
  const token = '0x' + 'AB'.repeat(20);
  const e = cleanEvent({ kind: 'view', visitor: id(1), session: id(2), page: 'token', token, network: 'base-sepolia', source: 'https://www.x.com/elpidadotfun/status/1', wallet: '0xme', query: 'pepe' }, { networks: new Set(['base-sepolia']), ownHost: 'elpida.fun' });
  assert.deepEqual(e, { kind: 'view', visitor: id(1), session: id(2), page: 'token', token: token.toLowerCase(), network: 'base-sepolia', source: 'x.com' }, 'only whitelisted fields survive');
  assert.equal(cleanEvent({ kind: 'view', visitor: id(1), session: id(2), page: 'explore', token, network: 'mars' }, { networks: new Set(['base-sepolia']) }).token, null, 'a token only on token pages');
  assert.equal(cleanEvent({ kind: 'view', visitor: id(1), session: id(2), page: 'explore', network: 'mars' }, { networks: new Set(['base-sepolia']) }).network, null);
  assert.equal(sourceOf('https://elpida.fun/#/launch', 'elpida.fun'), null, 'our own site is not a source');
  assert.equal(sourceOf('Telegram Ads!', null), 'telegramads');
  assert.equal(deviceOf(PHONE), 'mobile');
  assert.equal(deviceOf(DESKTOP), 'desktop');
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'tablet');
  assert.equal(deviceOf('Googlebot/2.1'), 'bot');
  assert.equal(countryOf('ng'), 'NG');
  assert.equal(countryOf('XX'), null);
  assert.equal(countryOf('T1'), null);
  assert.equal(countryOf('Nigeria'), null);
  assert.deepEqual(restrictedJurisdictions(' United States, Ontario ,,United States,<script>'), ['United States', 'Ontario', 'script']);
  assert.deepEqual(restrictedJurisdictions(undefined), []);
});

test('the store keeps salted hashes only, no IP or user agent, and summarises per visitor', () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const store = new SiteAnalytics({ now: () => clock });
  // Visitor 1 came 10 days ago, so today they count as returning.
  clock -= 10 * 86_400_000;
  store.record(view(1, 1), { userAgent: DESKTOP, country: 'NG' });
  clock += 10 * 86_400_000;
  store.record(view(1, 2, 'explore', { source: 'https://x.com/a' }), { userAgent: DESKTOP, country: 'NG' });
  store.record(view(1, 2, 'token', { token: '0x' + '11'.repeat(20), network: 'base-sepolia' }), { userAgent: DESKTOP, country: 'NG' });
  store.record(view(2, 3, 'launch'), { userAgent: PHONE, country: 'GB' });
  store.record(view(3, 4), { userAgent: 'Googlebot/2.1', country: 'US' });
  store.record(cleanEvent({ kind: 'consent', analytics: true }));
  store.record(cleanEvent({ kind: 'consent', analytics: false }));
  store.record(cleanEvent({ kind: 'consent', analytics: false }));
  store.record(cleanEvent({ kind: 'terms', accepted: true }));
  store.record(cleanEvent({ kind: 'terms', accepted: false }));

  const columns = store.db.prepare("SELECT name FROM pragma_table_info('views')").all().map(r => r.name);
  assert.ok(!columns.some(c => /ip|agent|wallet|address/i.test(c)), `no identifying columns: ${columns}`);
  const raw = JSON.stringify(store.db.prepare('SELECT * FROM views').all());
  assert.ok(!raw.includes(id(1)), 'raw visitor ids are never stored');

  const s = store.summary({ days: 7, label: (network, token) => network === 'base-sepolia' && token === '0x' + '11'.repeat(20) ? 'HOPE' : null });
  assert.equal(s.days, 7);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily.at(-1).day, '2026-10-30');
  assert.deepEqual({ ...s.totals.today }, { visitors: 2, sessions: 2, pageviews: 3 }, 'the bot is not counted');
  assert.equal(s.totals.d30.visitors, 2);
  assert.equal(s.totals.d30.sessions, 3);
  assert.deepEqual(s.returning, { returning: 1, new: 1 });
  assert.deepEqual(s.tokens, [{ network: 'base-sepolia', token: '0x' + '11'.repeat(20), visitors: 1, pageviews: 1, label: 'HOPE' }]);
  assert.deepEqual(s.sources.map(r => r.key), ['x.com']);
  assert.deepEqual(s.countries.map(r => [r.key, r.visitors]), [['NG', 1], ['GB', 1]]);
  assert.deepEqual(s.devices.map(r => r.key).sort(), ['desktop', 'mobile']);
  assert.equal(s.pages[0].key, 'explore');
  assert.deepEqual(s.consent, { accepted: 1, declined: 2 });
  assert.deepEqual(s.terms, { accepted: 1, declined: 1 });
  assert.equal(store.summary({ days: 12345 }).days, 30, 'unknown periods fall back to 30 days');

  // Retention: rows older than 90 days go at the next write.
  clock += (RETAIN_DAYS + 2) * 86_400_000;
  store.record(view(9, 9), { userAgent: DESKTOP });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM views').get().n, 1);
  assert.equal(dayOf(clock), store.db.prepare('SELECT day FROM views').get().day);
  store.close();
});

test('the telemetry limiter caps each client and the total per minute', () => {
  let clock = 0;
  const limited = telemetryLimiter({ perMinute: 3, globalPerMinute: 4, now: () => clock });
  assert.deepEqual([1, 2, 3, 4].map(() => limited('a')), [false, false, false, true]);
  assert.equal(limited('b'), true, 'the global cap applies across clients');
  clock += 60_000;
  assert.equal(limited('a'), false, 'a new window starts after a minute');
});

test('the browser counts only known pages and never the operator panel or search text', () => {
  assert.deepEqual(pageOf('#/'), { page: 'explore', token: null, network: null });
  assert.deepEqual(pageOf('#/?q=pepe&sort=new'), { page: 'explore', token: null, network: null });
  assert.deepEqual(pageOf('#/docs/risk'), { page: 'docs', token: null, network: null });
  assert.deepEqual(pageOf(`#/token/${'0x' + 'ab'.repeat(20)}?network=base-sepolia`), { page: 'token', token: '0x' + 'ab'.repeat(20), network: 'base-sepolia' });
  assert.equal(pageOf('#/monkey?tab=visitors'), null);
  assert.equal(pageOf('#/nowhere').page, 'notfound');
  assert.equal(visitSource('?utm_source=telegram', 'https://google.com/'), 'telegram');
  assert.equal(visitSource('', 'https://google.com/'), 'https://google.com/');
  assert.equal(visitSource('', ''), null);
});

test('Terms and cookie choices are versioned; the restricted places follow the operator setting', () => {
  assert.equal(termsAccepted({ v: TERMS_VERSION, at: 1 }), true);
  assert.equal(termsAccepted({ v: TERMS_VERSION - 1, at: 1 }), false, 'a new version asks again');
  assert.equal(termsAccepted(null), false);
  assert.deepEqual(consentChoice({ v: CONSENT_VERSION, analytics: false, at: 1 }), { analytics: false });
  assert.equal(consentChoice({ v: CONSENT_VERSION, analytics: 'yes' }), null);
  const text = doc => JSON.stringify(doc);
  const plain = termsDocument();
  assert.doesNotMatch(text(plain), /using the Services from/, 'no named places unless the operator sets them');
  assert.match(text(termsDocument({ restricted: ['United States', 'Ontario', 'Canada'] })), /using the Services from United States, Ontario or Canada;/);
  assert.match(text(plain), /Cuba, Iran, North Korea/, 'comprehensively sanctioned places are always restricted');
  assert.match(plain.notice[0], /no monetary value/);
  assert.doesNotMatch(plain.notice[0], /lose everything/, 'testnet terms do not claim real losses');
  assert.match(termsDocument({ mainnet: true }).notice[0], /Networks marked mainnet use real funds/);
  // Tokenized stocks (13 November): US Persons excluded in the Terms, no affiliation with Ondo, issuer risks, and the
  // notice points at the section.
  const stocks = plain.sections.find(([t]) => t === 'Tokenized stock pairs');
  assert.ok(stocks, 'a Tokenized stock pairs section');
  assert.match(text(stocks), /not offered to, and may not be used by, US Persons/);
  assert.match(text(stocks), /not affiliated with, endorsed, sponsored or approved by Ondo Global Markets/);
  assert.match(text(stocks), /does not make you a shareholder/);
  assert.match(text(stocks), /pause, freeze, block or reverse transfers/);
  assert.doesNotMatch(text(plain), /Powered by Ondo|Built on Ondo/i);
  assert.match(plain.notice.join(' '), new RegExp(`section ${plain.sections.findIndex(([t]) => t === 'Tokenized stock pairs') + 1} before using them`));
  // Section references in the notice point at the sections they name.
  const titles = plain.sections.map(([t]) => t);
  assert.match(plain.notice[0], new RegExp(`sections ${titles.indexOf('Test networks and the mainnet beta') + 1} and ${titles.indexOf('Risks you accept') + 1}`));
  assert.match(plain.notice[1], new RegExp(`section ${titles.indexOf('Not advice, not an offer') + 1} `));
  assert.equal(titles.indexOf('Who may use Elpida'), 3, 'the checkbox cites section 4 for Restricted Persons');
  assert.doesNotMatch(text(plain), /StonkFun|stonkfun/i);
  assert.equal(disclaimerPoints().length, 3);
  assert.match(disclaimerPoints({ mainnet: true })[0].text, /real funds/);
  assert.match(fullDisclaimer().join(' '), /no monetary value/);
  assert.match(fullDisclaimer({ mainnet: true }).join(' '), /Networks marked mainnet use real funds/);
});

test('the page wires the banner, footer links and stylesheet; no module sets a style attribute', () => {
  const html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/consent\.css">/);
  assert.match(html, /data-cookie-settings/);
  assert.match(html, /href="#\/docs\/privacy"/);
  assert.match(html, /href="#\/terms"/);
  const app = readFileSync(new URL('../apps/web/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /initConsent\(\{ config \}\)/);
});

test('telemetry needs the page token, stores a view, and the Visitors summary is operator-only', async t => {
  const app = await startServer({ port: 0, seed: false });
  t.after(() => app.close());
  const config = await (await fetch(`${app.url}/api/config`)).json();
  assert.deepEqual(config.consent, { restricted: [] });
  const post = (body, headers = {}) => fetch(`${app.url}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ kind: 'terms', accepted: true }, { 'X-Elpida-Token': 'wrong' })).status, 403);
  const ok = await post({ kind: 'view', visitor: id(7), session: id(8), page: 'launch', network: 'local' }, { 'CF-IPCountry': 'NG', 'User-Agent': DESKTOP });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { recorded: true });
  assert.equal((await post({ kind: 'view', visitor: id(7), session: id(8), page: 'monkey' })).status, 400);
  assert.equal((await fetch(`${app.url}/api/admin/visitors`)).status, 401);
  for (const path of ['/consent.mjs', '/terms.mjs', '/consent.css', '/admin-visitors.mjs']) assert.equal((await fetch(`${app.url}${path}`)).status, 200, path);
});
