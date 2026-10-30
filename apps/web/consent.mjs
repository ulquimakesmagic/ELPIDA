// Terms of Use dialog, cookie banner and opt-in page-view analytics (docs/SITE_ANALYTICS.md).
//
// 1. Terms of Use: a blocking dialog on first visit (and again whenever TERMS_VERSION changes) with the full Terms
//    (terms.mjs), one checkbox and Decline / Accept. Nothing else on the page works until the visitor accepts.
//    The same Terms are at #/terms.
// 2. Cookie banner: essential storage only by default. Analytics is off until the visitor allows it, and can be
//    turned off again from "Cookie settings" in the footer. A browser that sends Global Privacy Control is not asked
//    and stays essential-only.
// 3. Page views: sent only with analytics allowed. A view says which page (from a fixed list), the token being viewed,
//    the chosen network and, on the first view, where the visit came from. Never a wallet address or search text.
//    Choices (Terms accepted or declined, analytics allowed or declined) are counted without any id.
// Everything is stored in localStorage, wrapped in try/catch: a browser that blocks storage sees the dialog each visit.
import { h, icon } from './ui.mjs';
import { TERMS_VERSION, termsDocument, renderTermsBody } from './terms.mjs';

export const CONSENT_VERSION = 1;
const KEYS = { terms: 'elpida:terms', consent: 'elpida:consent', visitor: 'elpida:vid', session: 'elpida:sid', network: 'elpida:network' };

/** The three points of the risk disclaimer on the Docs page. */
export function disclaimerPoints({ mainnet = false } = {}) {
  return [
    { key: 'risk', icon: 'triangle-alert', title: 'Trading risk', text: `Tokens launched here are highly volatile and most lose all their value. ${mainnet ? 'On Solana mainnet beta you trade with real funds: only use what you can afford to lose.' : 'Most networks here are test networks, where tokens have no monetary value.'}` },
    { key: 'advice', icon: 'circle-help', title: 'Not financial advice', text: 'Nothing on Elpida is investment, financial, legal or tax advice. Tokens are created by anyone and are not endorsed by Elpida. Do your own research.' },
    { key: 'yours', icon: 'shield-check', title: 'Your responsibility', text: 'The contracts have not had an independent audit and bugs are possible. You control your wallet and approve every transaction yourself. Make sure using Elpida is legal where you are.' },
  ];
}

/** The longer risk disclaimer on the Docs page, as paragraphs. */
export function fullDisclaimer({ mainnet = false } = {}) {
  return [
    'Elpida is experimental software provided “as is”, without warranties of any kind. Elpida does not hold your keys or funds: you interact with smart contracts directly from your own wallet, and every transaction is final once confirmed.',
    'Anyone can create a token on Elpida. Elpida does not review, endorse or guarantee any token, creator, link or image, and a listing is not a recommendation. Token prices are set by a bonding curve and later by a DEX pool, and can fall to zero.',
    mainnet ? 'Solana runs as an invite-only mainnet beta with real funds and contracts that have not had an independent audit. All other networks are public test networks whose tokens have no monetary value.' : 'Elpida currently runs on public test networks and a local simulation. Test tokens have no monetary value and cannot be exchanged for money.',
    'Smart contracts, wallets, RPC providers, bridges, oracles and DEXs can fail, be exploited or behave unexpectedly. Network fees are paid to the network, not to Elpida, and are not refundable.',
    'You are responsible for complying with the laws and tax rules that apply to you. Do not use Elpida if it is prohibited where you live or are located, or if you are subject to sanctions.',
    'Nothing on Elpida, including analytics, rankings and creator content, is investment, financial, legal or tax advice.',
  ];
}

export function readSaved(store, key) { try { return JSON.parse(store?.getItem(key) ?? 'null'); } catch { return null; } }
function save(store, key, value) { try { store?.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); return true; } catch { return false; } }
function drop(store, key) { try { store?.removeItem(key); } catch {} }

/** True when this browser accepted the current version of the Terms. */
export const termsAccepted = saved => !!saved && saved.v === TERMS_VERSION && Number.isFinite(saved.at);
/** The saved cookie choice for the current version, or null when the visitor has not chosen yet. */
export const consentChoice = saved => saved && saved.v === CONSENT_VERSION && typeof saved.analytics === 'boolean' ? { analytics: saved.analytics } : null;

const ROUTES = { '/': 'explore', '': 'explore', '/launch': 'launch', '/portfolio': 'portfolio', '/rewards': 'rewards', '/analytics': 'analytics', '/docs': 'docs', '/partners': 'partners', '/terms': 'terms' };
/**
 * The page a hash route counts as, or null for pages that are never counted (the operator panel). Only the page name,
 * a token address and its network leave the browser; query text such as a search never does.
 */
export function pageOf(hash) {
  const [path = '', query = ''] = String(hash ?? '').replace(/^#/, '').split('?');
  if (path === '/monkey') return null;
  if (/^\/docs\/[a-z-]+$/.test(path)) return { page: 'docs', token: null, network: null };
  const token = path.match(/^\/token\/([A-Za-z0-9]{32,64})$/);
  if (token) return { page: 'token', token: token[1], network: new URLSearchParams(query).get('network') };
  return { page: ROUTES[path] ?? 'notfound', token: null, network: null };
}

/** Where this visit came from: a ?ref= or utm_source tag on the URL, else the referring site. */
export function visitSource(search, referrer) {
  const params = new URLSearchParams(String(search ?? ''));
  return (params.get('ref') || params.get('utm_source') || String(referrer ?? '')).slice(0, 200) || null;
}

const randomId = () => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); };

/** Starts the Terms dialog, the banner and page-view tracking. Call once the app has its config. */
export function initConsent({ config, local = globalThis.localStorage, session = globalThis.sessionStorage } = {}) {
  const mainnet = !!config?.solana?.mainnet;
  const gpc = !!globalThis.navigator?.globalPrivacyControl;
  let lastView = { key: '', at: 0 }, sentSource = false, banner = null;

  function post(body) {
    try {
      fetch('/api/telemetry', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': config.csrf }, body: JSON.stringify(body) }).catch(() => {});
    } catch {}
  }
  const analyticsOn = () => consentChoice(readSaved(local, KEYS.consent))?.analytics === true;
  function visitorId() {
    let id = null; try { id = local.getItem(KEYS.visitor); } catch {}
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) { id = randomId(); save(local, KEYS.visitor, id); }
    return id;
  }
  function sessionId() {
    let id = null; try { id = session.getItem(KEYS.session); } catch {}
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) { id = randomId(); save(session, KEYS.session, id); }
    return id;
  }
  function trackView() {
    if (!analyticsOn() || !termsAccepted(readSaved(local, KEYS.terms))) return;
    const view = pageOf(location.hash);
    if (!view) return;
    const key = `${view.page}:${view.token ?? ''}`, now = Date.now();
    if (key === lastView.key && now - lastView.at < 2000) return; // a route that rewrites its own hash counts once
    lastView = { key, at: now };
    let network = view.network; if (!network) { try { network = local.getItem(KEYS.network); } catch {} }
    const body = { kind: 'view', visitor: visitorId(), session: sessionId(), page: view.page, token: view.token, network: network || null };
    if (!sentSource) { body.source = visitSource(location.search, document.referrer); sentSource = true; }
    post(body);
  }
  function choose(analytics) {
    save(local, KEYS.consent, { v: CONSENT_VERSION, analytics, at: Date.now() });
    if (!analytics) drop(local, KEYS.visitor);
    post({ kind: 'consent', analytics });
    closeBanner();
    if (analytics) trackView();
  }

  /* ---------- Cookie banner ---------- */
  function closeBanner() { banner?.remove(); banner = null; }
  function openBanner({ settings = false } = {}) {
    closeBanner();
    const current = consentChoice(readSaved(local, KEYS.consent));
    const analytics = h('input', { type: 'checkbox', id: 'ck-analytics', checked: current?.analytics ?? false });
    const panel = h('div.ck-settings', { hidden: !settings },
      h('label.ck-row', h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', h('strong', 'Essential'), h('small', 'Remembers your network, theme, wallet choice and the answers on this banner. Always on.'))),
      h('label.ck-row', { for: 'ck-analytics' }, analytics, h('span', h('strong', 'Analytics'), h('small', 'Counts which pages are visited, from which country and device type, with a random id kept in this browser. No IP address, wallet address or advertising.'))),
      h('div.ck-actions', h('button.btn-accent.btn-accent-sm', { type: 'button', on: { click: () => choose(analytics.checked) } }, 'Save choices')));
    const settingsButton = h('button.link-plain.ck-link', { type: 'button', 'aria-expanded': String(settings), on: { click: () => { panel.hidden = !panel.hidden; settingsButton.setAttribute('aria-expanded', String(!panel.hidden)); } } }, icon('sliders-horizontal', 'icon-sm'), 'Settings');
    banner = h('section.ck-banner', { role: 'region', 'aria-label': 'Cookie preferences' },
      h('div.ck-main',
        h('div.ck-text', h('strong', 'Cookies and analytics'), h('p', 'Elpida uses essential cookies and browser storage to work. With your permission it also counts page visits to improve the site. Nothing is sold or shared with advertisers. ', h('a', { href: '#/docs/privacy' }, 'Privacy'))),
        h('div.ck-buttons',
          h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => choose(false) } }, 'Essential only'),
          h('button.btn-accent.btn-accent-sm', { type: 'button', on: { click: () => choose(true) } }, 'Allow analytics'),
          settingsButton)),
      panel);
    document.body.append(banner);
  }

  /* ---------- Terms of Use ---------- */
  function openTerms() {
    const doc = termsDocument({ mainnet, restricted: config?.consent?.restricted });
    const agree = h('input', { type: 'checkbox', id: 'tm-agree' });
    const accept = h('button.btn-accent.tm-accept', { type: 'button', disabled: true }, 'Accept');
    const decline = h('button.btn.btn-secondary.tm-decline', { type: 'button' }, 'Decline');
    agree.addEventListener('change', () => { accept.disabled = !agree.checked; });
    const body = h('div.tm-body', { tabindex: '0', 'aria-label': 'Terms of Use text' }, renderTermsBody(doc));
    const terms = h('div.tm-terms',
      h('header.tm-head', h('h2', { id: 'tm-title' }, doc.title), h('p', `Last updated: ${doc.updated}`)),
      body,
      h('footer.tm-foot',
        h('label.tm-check', { for: 'tm-agree' }, agree, h('span', 'I have read and agree to the Elpida Terms of Use, and I am not a Restricted Person (section 4).')),
        h('div.tm-buttons', decline, accept)));
    const declined = h('div.tm-declined', { hidden: true },
      h('span.dl-mark', icon('lock')),
      h('h2', 'You need to accept the Terms to use Elpida'),
      h('p', 'Elpida cannot be used without agreeing to its Terms of Use. If you change your mind, review them again.'),
      h('button.btn-accent', { type: 'button', on: { click: () => { declined.hidden = true; terms.hidden = false; body.scrollTop = 0; } } }, 'Review the Terms'));
    const dialog = h('dialog.tm-dialog', { 'aria-labelledby': 'tm-title' }, terms, declined);
    let done = false;
    // Escape must not dismiss it; if the browser closes it anyway (repeated Escape), it opens again.
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.addEventListener('close', () => { if (!done) dialog.showModal(); });
    decline.addEventListener('click', () => { post({ kind: 'terms', accepted: false }); agree.checked = false; accept.disabled = true; terms.hidden = true; declined.hidden = false; });
    accept.addEventListener('click', () => {
      if (!agree.checked) return;
      done = true;
      save(local, KEYS.terms, { v: TERMS_VERSION, at: Date.now() });
      post({ kind: 'terms', accepted: true });
      dialog.close(); dialog.remove();
      start();
    });
    document.body.append(dialog);
    dialog.showModal();
    body.focus({ preventScroll: true });
  }

  function start() {
    const choice = consentChoice(readSaved(local, KEYS.consent));
    if (!choice && !gpc) openBanner();
    trackView();
  }

  window.addEventListener('hashchange', trackView);
  document.addEventListener('click', event => { if (event.target.closest?.('[data-cookie-settings]')) { event.preventDefault(); openBanner({ settings: true }); } });
  if (!termsAccepted(readSaved(local, KEYS.terms))) openTerms(); else start();
  return { openBanner, trackView };
}
