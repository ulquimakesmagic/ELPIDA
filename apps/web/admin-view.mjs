import { h, icon, short, number, compact, errorText } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { withWalletTimeout } from './wallet.mjs';
import { renderPartners } from './admin-partners.mjs';
import { renderVisitors } from './admin-visitors.mjs';
import { renderLaunchpads } from './admin-launchpads.mjs';
import { renderPairs } from './admin-pairs.mjs';

// Operator panel (#/monkey; deliberately not #/admin, the first path scanners try). The Operations tab is read-only:
// health, treasury balances, activity, indexers, the price
// relay, graduation and backups. The Partners tab (#/monkey?tab=partners) reviews early-partner applications; see
// admin-partners.mjs. The Pairs tab (#/monkey?tab=pairs) holds every trading-pair approval and the test stock tools;
// see admin-pairs.mjs. The Launchpads tab (#/monkey?tab=launchpads) holds every launchpad deployment; see
// admin-launchpads.mjs. The Visitors tab (#/monkey?tab=visitors) shows opt-in site analytics; see admin-visitors.mjs. Sign-in is a wallet signature checked by the server against the factory treasuries and
// ELPIDA_ADMIN_ADDRESSES; the session is an HttpOnly cookie the page never sees. The Operations tab sends nothing; Partners and Pairs send treasury calls only when the operator confirms them.

const ago = iso => { const t = typeof iso === 'number' ? iso : Date.parse(iso ?? ''); if (!Number.isFinite(t) || t <= 0) return 'never'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const usd = v => Number.isFinite(Number(v)) ? `$${Number(v) < 1000 ? number(v, 2) : compact(v)}` : '—';
const pill = (state, ...rest) => h(`span.op-pill.op-${state}`, ...rest);
const level = ok => ok === true ? 'ok' : ok === false ? 'bad' : 'warn';

async function getJson(path, init) {
  const response = await fetch(`/api/${path}`, { credentials: 'same-origin', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status}).`), { status: response.status });
  return data;
}

export function renderAdmin(ctx, { connect }) {
  const root = h('div.op');
  const status = h('p.small.muted', { role: 'status', 'aria-live': 'polite' });

  function signInView(message) {
    const evm = ctx.mode === 'testnet' && ctx.wallet !== ctx.solWallet;
    const address = evm ? ctx.wallet?.address : null;
    const error = h('p.error-text', { role: 'alert' }, message ?? '');
    const button = h('button.btn-accent', { type: 'button', disabled: !address, on: { click: async () => {
      error.textContent = ''; button.disabled = true; status.textContent = 'Waiting for your wallet…';
      try {
        const challenge = await getJson('admin/challenge');
        await ctx.wallet.checkNetwork?.();
        const signature = await withWalletTimeout(ctx.wallet.signer.signMessage(challenge.message), ctx.wallet.walletName);
        status.textContent = 'Checking…';
        await getJson('admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': ctx.config.csrf }, body: JSON.stringify({ nonce: challenge.nonce, address, signature }) });
        status.textContent = ''; load();
      } catch (e) { status.textContent = ''; error.textContent = errorText(e); button.disabled = false; }
    } } }, icon('wallet', 'icon-sm'), 'Sign in with this wallet');
    return h('section.op-signin.tk-card',
      h('span.pf-mark', icon('shield-check')),
      h('h1', 'Operator sign-in'),
      h('p.muted', 'Read-only operations view. Sign a message with a factory treasury wallet or an address listed in ELPIDA_ADMIN_ADDRESSES. Signing is free and sends no transaction.'),
      !evm ? h('p.small.muted', 'Switch to an EVM network (Base, Ethereum, BNB or Robinhood) to sign in.')
        : address ? h('p.small', 'Wallet: ', h('span.mono', short(address)))
        : h('button.btn.btn-secondary', { type: 'button', on: { click: connect } }, 'Connect wallet'),
      evm ? button : null, status, error);
  }

  function dashboard(d, refresh) {
    const health = d.health ?? {}, incidents = health.incidents ?? [];
    const statusLevel = health.status === 'ok' ? 'ok' : health.status === 'critical' ? 'bad' : 'warn';
    const banner = h(`section.op-banner.op-${statusLevel}`,
      h('div', h('strong', health.status === 'ok' ? 'All systems normal' : health.status === 'critical' ? 'Critical issues' : 'Needs attention'),
        h('span.muted', ` · checked ${ago(d.generatedAt)}`)),
      incidents.length ? h('ul.op-incidents', incidents.map(i => h('li', pill(i.severity === 'critical' ? 'bad' : 'warn', i.severity), h('span', i.message), h('code.muted', i.code)))) : h('p.small.muted', 'No incidents.'));

    const act = period => d.activity?.[period]?.totals ?? null;
    const tile = (label, value, note) => h('div.tk-strip-tile', h('span', label), h('strong', value, note ? h('small', ` ${note}`) : null));
    const all = act('all'), day = act('24h'), week = act('7d');
    const strip = h('section.tk-strip.op-strip', { 'aria-label': 'Activity' },
      tile('Volume 24h', day ? usd(day.volumeUsd) : '—', day ? `${number(day.trades, 0)} trades` : ''),
      tile('Volume 7d', week ? usd(week.volumeUsd) : '—', week ? `${number(week.trades, 0)} trades` : ''),
      tile('Volume all time', all ? usd(all.volumeUsd) : '—', all?.unpricedTrades ? `${all.unpricedTrades} unpriced` : ''),
      tile('Tokens', all ? number(all.tokens, 0) : '—', all ? `${number(all.graduated, 0)} graduated` : ''),
      tile('Launches 24h', day ? number(day.launches, 0) : '—'),
      tile('Traders all time', all ? number(all.addresses, 0) : '—'));

    const card = (title, ...content) => h('section.tk-card.op-card', h('h2.tk-h', title), ...content);
    const kv = rows => h('dl.op-kv', rows.filter(Boolean).flatMap(([k, v]) => [h('dt', k), h('dd', v)]));

    const treasury = card('Treasury',
      h('div.table-scroll', h('table.market-table.tk-table.op-table',
        h('thead', h('tr', ...['Network', 'Treasury', 'Native', 'USDC', ''].map((l, i) => h('th', { scope: 'col', class: i > 1 && i < 4 ? 'num' : '' }, l)))),
        h('tbody', (d.treasury ?? []).map(t => h('tr',
          h('td', h('span.op-net', chainIcon(t.network), t.name ?? t.network)),
          h('td', t.treasury ? h('a.mono', { href: t.explorer ? `${t.explorer}/address/${t.treasury}` : '#', target: '_blank', rel: 'noopener noreferrer' }, short(t.treasury)) : t.error ? pill('bad', { title: t.error }, 'RPC unavailable') : h('span.muted', '—')),
          h('td.num', t.native != null ? `${number(t.native, 5)} ${t.nativeSymbol}` : '—'),
          h('td.num', t.usdc ? `${number(t.usdc.balance, 2)}` : '—'),
          h('td', t.error && t.treasury ? h('span.op-pill.op-warn', { title: t.error }, 'partial') : null)))))),
      h('p.meta', 'Read from each factory’s treasury() and feeUsdc(), cached for a minute. The treasury cannot be changed after deployment.'));

    const nets = card('Indexers',
      h('div.table-scroll', h('table.market-table.tk-table.op-table',
        h('thead', h('tr', ...['Network', 'State', 'Indexed block', 'Lag', 'Last success'].map((l, i) => h('th', { scope: 'col', class: i > 1 && i < 4 ? 'num' : '' }, l)))),
        h('tbody', Object.entries(d.networks ?? {}).map(([key, n]) => {
          const fresh = n.enabled !== false && !n.error && n.lastSuccess && Date.now() - Date.parse(n.lastSuccess) < 180000;
          return h('tr', h('td', h('span.op-net', chainIcon(key), n.name ?? key)),
            h('td', n.enabled === false ? pill('warn', { title: n.reason ?? '' }, 'off') : n.error ? pill('bad', { title: `${n.error}${n.rpc ? ` · ${n.rpc}` : ''}` }, n.errorCode ?? 'error') : pill(fresh ? 'ok' : 'warn', { title: n.rpc ?? '' }, fresh ? 'fresh' : 'behind')),
            h('td.num', n.indexedBlock != null ? number(n.indexedBlock, 0) : n.cursorSlot != null ? number(n.cursorSlot, 0) : '—'),
            h('td.num', n.lag != null ? number(n.lag, 0) : '—'),
            h('td', ago(n.lastSuccess)));
        })))));

    const relayNets = Object.entries(d.relay?.networks ?? {});
    const relay = card('Price relay',
      d.relay?.enabled ? h('p.small', 'Updater ', h('span.mono', short(d.relay.address ?? ''))) : h('p.small.muted', d.relay?.misconfigured ? 'Misconfigured. Check ELPIDA_TESTNET_RELAY_KEY.' : 'Not configured on this server.'),
      relayNets.length ? kv(relayNets.map(([key, r]) => [h('span.op-net', chainIcon(key), key), h('span', r.error ? pill('bad', 'error') : pill('ok', 'posting'), ` last post ${ago(r.lastPost)}`, r.balance != null ? ` · gas ${number(r.balance, 5)}` : '', r.error ? h('small.muted', ` ${r.error}`) : null)])) : null);

    const g = d.graduation ?? {};
    const graduation = card('Graduation service', kv([
      ['State', g.enabled === false ? pill('warn', 'off') : pill(g.state === 'watching' ? 'ok' : 'warn', g.state ?? 'unknown')],
      g.reason ? ['Reason', g.reason] : null,
      g.factory ? ['Factory', h('span.mono', short(g.factory))] : null,
      g.checkedAt ? ['Checked', ago(g.checkedAt)] : null,
    ]));

    const b = d.backup ?? {}, m = b.mirror ?? {};
    const backup = card('Backups', kv([
      ['Local backup', b.enabled ? h('span', pill(b.lastError ? 'bad' : 'ok', b.lastError ? 'failing' : 'ok'), ` last success ${ago(b.lastSuccess)}`) : pill('warn', 'off')],
      ['Off-site mirror', m.enabled ? h('span', pill(m.lastError ? 'bad' : m.current ? 'ok' : 'warn', m.lastError ? 'failing' : m.current ? 'current' : 'behind'), ` last success ${ago(m.lastSuccess)}`) : pill('warn', 'off')],
      ['Persistent storage', pill(level(d.storage?.durable), d.storage?.durable ? 'volume mounted' : 'ephemeral')],
      b.lastError ? ['Last error', h('small.muted', String(b.lastError))] : null,
    ]));

    const priceRows = Object.entries(d.prices ?? {}).filter(([, p]) => p && typeof p === 'object' && p.symbol);
    const prices = priceRows.length ? card('Price references', kv(priceRows.map(([key, p]) => [h('span.op-net', chainIcon(key), `${key} · ${p.symbol}`),
      h('span', pill(p.status === 'fresh' ? 'ok' : p.status === 'stale' ? 'warn' : 'bad', p.status ?? 'unknown'), p.usd != null ? ` ${usd(p.usd)}` : '', h('small.muted', ` ${p.source ?? ''}${p.updatedAt ? ` · ${ago(p.updatedAt * 1000)}` : ''}`))]))) : null;

    return h('div.op-dash',
      h('header.op-head',
        h('div', h('h1', 'Operations'), h('p.small.muted', 'Read-only · signed in as ', h('span.mono', short(d.operator)))),
        h('div.op-actions', h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: refresh } }, icon('refresh-cw', 'icon-sm'), 'Refresh'),
          h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: async () => { try { await getJson('admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': ctx.config.csrf }, body: '{}' }); } catch {} load(); } } }, 'Sign out'))),
      banner, strip,
      h('div.op-grid', treasury, nets),
      h('div.op-grid.op-grid-3', relay, graduation, backup),
      prices);
  }

  async function load() {
    root.replaceChildren(h('p.muted', 'Loading…'));
    try {
      const session = await getJson('admin/session');
      if (!session.signedIn) { root.replaceChildren(signInView()); return; }
      const tab = { partners: 'partners', visitors: 'visitors', pairs: 'pairs', launchpads: 'launchpads' }[new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab')] ?? 'ops';
      const tabs = h('nav.op-tabs', { 'aria-label': 'Admin sections' },
        h('a', { href: '#/monkey', 'aria-current': tab === 'ops' ? 'page' : undefined }, 'Operations'),
        h('a', { href: '#/monkey?tab=partners', 'aria-current': tab === 'partners' ? 'page' : undefined }, 'Partners'),
        h('a', { href: '#/monkey?tab=launchpads', 'aria-current': tab === 'launchpads' ? 'page' : undefined }, 'Launchpads'),
        h('a', { href: '#/monkey?tab=pairs', 'aria-current': tab === 'pairs' ? 'page' : undefined }, 'Pairs'),
        h('a', { href: '#/monkey?tab=visitors', 'aria-current': tab === 'visitors' ? 'page' : undefined }, 'Visitors'));
      if (tab === 'partners') { root.replaceChildren(tabs, renderPartners(ctx, { getJson })); return; }
      if (tab === 'visitors') { root.replaceChildren(tabs, renderVisitors(ctx, { getJson })); return; }
      if (tab === 'launchpads') { const pads = renderLaunchpads(ctx, { connect }); root.replaceChildren(tabs, pads.root); ctx.refresh?.().catch(() => {}).finally(pads.update); return; }
      if (tab === 'pairs') { const pairs = renderPairs(ctx, { connect }); root.replaceChildren(tabs, pairs.root); ctx.refresh?.().catch(() => {}).finally(pairs.update); return; }
      const data = await getJson('admin/overview');
      if (!root.isConnected) return;
      root.replaceChildren(tabs, dashboard(data, load));
    } catch (e) {
      root.replaceChildren(e.status === 401 ? signInView('Your session ended. Sign in again.') : h('div.pf-empty', h('h2', 'Operations view unavailable'), h('p', errorText(e)), h('button.btn.btn-secondary', { type: 'button', on: { click: load } }, 'Retry')));
    }
  }
  queueMicrotask(load);
  return root;
}
