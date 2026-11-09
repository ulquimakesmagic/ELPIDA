import { h, icon, number, compact, short } from './ui.mjs';

// Analytics page, Rewards section (ELPIDA V2.0). Everything here is read from the V2 contracts by the server's rewards
// index (/api/public/v2-rewards): vault sizes by day, the airdrop and holder-reward rounds and their countdowns, how
// each round was distributed, and the flywheel's burns. With no V2 deployment the section stays hidden: no placeholder
// figures. The countdown ticks in the page against the round end the contract fixed.

const SVG = 'http://www.w3.org/2000/svg';
const VAULTS = [
  { key: 'airdrop', label: 'Trader airdrop', share: '30% of every fee', glyph: 'gift' },
  { key: 'holder', label: 'Holder rewards', share: '10% of every fee', glyph: 'users' },
  { key: 'flywheel', label: 'Flywheel', share: '10% of every fee', glyph: 'flame' },
];

/** Base units (decimal string) to a display number. Rewards stay far below 2^53 display units. */
const units = (value, decimals = 18) => Number(BigInt(value ?? 0)) / 10 ** decimals;
const pad = n => String(n).padStart(2, '0');
const dateOf = t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeOf = t => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

export function rewardsSection({ api }) {
  const root = h('section.panel.rw-section', { hidden: true, 'aria-labelledby': 'rw-title' });
  let data = null, chainKey = null, ticker = null, timer = null;

  const asset = (chain, address) => chain.assets?.[address] ?? chain.assets?.[address?.toLowerCase()] ?? { symbol: short(address), decimals: 18, usd: null };
  const amount = (chain, address, value) => {
    const a = asset(chain, address), n = units(value, a.decimals);
    return { text: `${number(n, n < 1 ? 6 : 4)} ${a.symbol}`, usd: a.usd ? n * a.usd : null };
  };
  /** A tile value: dollars when the asset has a fresh price, else the asset amount. */
  const headline = (chain, address, value) => { const m = amount(chain, address, value); return m.usd === null ? m.text : '$' + (m.usd < 1 ? m.usd.toFixed(m.usd < 0.01 ? 4 : 2) : compact(m.usd)); };
  const sub = (chain, address, value) => { const m = amount(chain, address, value); return m.usd === null ? '' : m.text; };
  const money = (chain, address, value) => {
    const m = amount(chain, address, value);
    return m.usd === null ? h('span', m.text) : h('span', h('span', '$' + compact(m.usd)), h('span.small.muted', ` · ${m.text}`));
  };

  function countdownCard(chain, kind, title) {
    const d = chain[kind];
    if (!d?.countdown?.started) return null;
    const c = d.countdown, cells = ['days', 'hours', 'minutes', 'seconds'].map(k => h('div.rw-cd-cell', h('strong', { 'data-part': k }, '--'), h('span', k)));
    const bar = h('div.rw-progress', h('span.rw-progress-fill'));
    const card = h('div.rw-countdown', { 'data-ends': String(c.endsAt), 'data-starts': String(c.startedAt) },
      h('div.rw-countdown-head', h('p.an-tile-label', icon(kind === 'airdrop' ? 'gift' : 'users', 'icon-sm'), title), h('span.badge', `Round ${c.round + 1}`)),
      h('div.rw-cd', { role: 'timer', 'aria-live': 'off', 'aria-label': `${title} round ends ${dateTimeOf(c.endsAt)}` }, ...cells),
      bar, h('p.small.muted', `Ends ${dateTimeOf(c.endsAt)}. ${kind === 'airdrop' ? 'Payouts are posted on chain after it ends.' : 'Holder rewards are paid each round.'}`));
    return card;
  }

  /** Updates every countdown on the page each second, from the round end the contract fixed. */
  function tick() {
    const now = Date.now() / 1000;
    for (const card of root.querySelectorAll('.rw-countdown')) {
      const ends = Number(card.dataset.ends), starts = Number(card.dataset.starts), left = Math.max(0, Math.floor(ends - now));
      const parts = { days: Math.floor(left / 86400), hours: pad(Math.floor(left % 86400 / 3600)), minutes: pad(Math.floor(left % 3600 / 60)), seconds: pad(left % 60) };
      for (const [k, v] of Object.entries(parts)) { const el = card.querySelector(`[data-part="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = String(v); }
      const fill = card.querySelector('.rw-progress-fill');
      if (fill) fill.style.width = `${Math.min(100, Math.max(0, (now - starts) / (ends - starts) * 100)).toFixed(2)}%`;
      if (left === 0 && !card.dataset.reloading) { card.dataset.reloading = '1'; setTimeout(load, 5000); }
    }
  }

  function vaultTiles(chain) {
    return h('div.analytics-metrics.rw-vaults', ...VAULTS.map(v => {
      const assets = chain[v.key]?.assets ?? [];
      const main = assets[0];
      const weekAgo = main?.series?.at(-8)?.size ?? '0', change = main ? units(BigInt(main.size) - BigInt(weekAgo), asset(chain, main.asset).decimals) : 0;
      return h('div.tile.analytics-metric', { 'data-hl': v.key === 'airdrop' ? 'true' : null },
        h('p.an-tile-label', icon(v.glyph, 'icon-sm'), v.label),
        h('strong', main ? headline(chain, main.asset, main.size) : '$0'),
        main && sub(chain, main.asset, main.size) ? h('p.small', sub(chain, main.asset, main.size)) : null,
        h('p.small.muted', `${v.share}${main && change > 0 ? ` · +${number(change, 6)} ${asset(chain, main.asset).symbol} in 7 days` : ''}`),
        assets.length > 1 ? h('p.small.muted', assets.slice(1).map(a => amount(chain, a.asset, a.size).text).join(' · ')) : null);
    }));
  }

  /** Daily vault sizes: one line per vault, in the main payout asset. */
  function sizeChart(chain) {
    const lines = VAULTS.map(v => ({ ...v, points: chain[v.key]?.assets?.[0]?.series ?? [], asset: chain[v.key]?.assets?.[0]?.asset })).filter(l => l.points.length);
    if (!lines.length) return h('p.small.muted', 'No fees have reached the vaults yet.');
    const days = [...new Set(lines.flatMap(l => l.points.map(p => p.day)))].sort((a, b) => a - b);
    const first = days[0], last = days.at(-1), span = Math.max(1, last - first);
    const max = Math.max(1e-18, ...lines.flatMap(l => l.points.map(p => units(p.size, asset(chain, l.asset).decimals))));
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 900 220'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Vault sizes by day, ${dateOf(first)} to ${dateOf(last)}`);
    for (let i = 0; i < 4; i++) { const g = document.createElementNS(SVG, 'line'); for (const [k, v] of Object.entries({ x1: 0, x2: 900, y1: 20 + i * 60, y2: 20 + i * 60 })) g.setAttribute(k, v); g.setAttribute('class', 'analytics-gridline'); svg.append(g); }
    for (const l of lines) {
      const pts = l.points.map(p => `${days.length === 1 ? 450 : (p.day - first) / span * 900},${200 - units(p.size, asset(chain, l.asset).decimals) / max * 180}`);
      const line = document.createElementNS(SVG, 'polyline'); line.setAttribute('points', pts.join(' ')); line.setAttribute('class', `rw-line rw-line-${l.key}`); svg.append(line);
    }
    const legend = h('div.rw-legend', ...lines.map(l => h('span', h('i', { class: `rw-swatch rw-swatch-${l.key}`, 'aria-hidden': 'true' }), `${l.label} (${asset(chain, l.asset).symbol})`)));
    return h('div.analytics-plot', svg, h('div.analytics-axis', h('span', dateOf(first)), h('span', `Peak ${number(max, 6)} ${asset(chain, lines[0].asset).symbol}`), h('span', dateOf(last))), legend);
  }

  function distribution(chain) {
    const rounds = chain.airdrop?.rounds ?? [];
    if (!rounds.length) return h('div.rw-empty', h('p', 'No airdrop round has been paid yet.'), h('p.small.muted', 'The first payouts are posted on chain when the current round ends.'));
    const r = rounds[0], s = r.stats, maxBand = Math.max(1, ...s.bands.map(b => b.count));
    return h('div.rw-distribution',
      h('div.analytics-summary',
        tile('Traders paid', `${number(r.paidRecipients, 0)} of ${number(r.recipients, 0)}`, `Round ${r.round + 1} · ${dateOf(r.start)}–${dateOf(r.end - 1)}`, 'users'),
        tile('Median payout', headline(chain, r.asset, s.median), [sub(chain, r.asset, s.median), 'Half of traders received more'].filter(Boolean).join(' · '), 'percent'),
        tile('Smallest / largest', `${headline(chain, r.asset, s.smallest)} / ${headline(chain, r.asset, s.largest)}`, 'No trader above 1% of the pool', 'arrow-down-up'),
        tile('Top 1% of traders', `${number(s.top1Share * 100, 1)}%`, 'Share of what was paid', 'chart-column')),
      h('div.rw-bands', { role: 'list', 'aria-label': 'Payouts by size' }, ...s.bands.map(b => {
        const fill = h('span.rw-band-fill'); fill.style.width = `${(b.count / maxBand * 100).toFixed(1)}%`;
        return h('div.rw-band', { role: 'listitem' }, h('span.rw-band-label', `${b.label} ${asset(chain, r.asset).symbol}`), h('span.rw-band-bar', fill), h('span.rw-band-count', number(b.count, 0)));
      })),
      h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Round', 'Pool', 'Traders', 'Paid', 'Unclaimed', 'Posted'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', ...rounds.map(x => h('tr', h('td', `Round ${x.round + 1}`, h('p.small.muted', `${dateOf(x.start)}–${dateOf(x.end - 1)}`)), h('td', money(chain, x.asset, x.total)), h('td', number(x.recipients, 0)), h('td', number(x.paidRecipients, 0), x.failed ? h('p.small.muted', `${x.failed} transfer${x.failed === 1 ? '' : 's'} to retry`) : null),
          h('td', x.expired ? 'Returned to the pool' : amount(chain, x.asset, x.unclaimed).text), h('td', chain.explorer ? h('a.mono', { href: `${chain.explorer}/tx/${x.postTx}`, target: '_blank', rel: 'noopener noreferrer' }, dateOf(x.postedAt)) : dateOf(x.postedAt))))))));
  }

  function lookup() {
    const input = h('input.input', { placeholder: '0x… your wallet', spellcheck: false, autocomplete: 'off', 'aria-label': 'Wallet address' });
    const out = h('div.rw-lookup-out', { 'aria-live': 'polite' });
    const go = async () => {
      out.replaceChildren(h('p.small.muted', 'Checking…'));
      try {
        const r = await api(`public/v2-rewards/payouts?wallet=${encodeURIComponent(input.value.trim())}`);
        const rows = r.chains.flatMap(c => c.payouts.map(p => ({ ...p, chain: data.chains.find(x => x.key === c.key) ?? { assets: {} }, chainName: c.name })));
        out.replaceChildren(rows.length ? h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Received', 'Chain', 'Reward', 'Round', 'Transaction'].map(t => h('th', { scope: 'col' }, t)))),
          h('tbody', ...rows.map(p => h('tr', h('td', money(p.chain, p.asset, p.amount)), h('td', p.chainName), h('td', p.kind === 'airdrop' ? 'Trader airdrop' : 'Holder rewards'), h('td', `Round ${p.round + 1}`),
            h('td', p.chain.explorer ? h('a.mono', { href: `${p.chain.explorer}/tx/${p.tx}`, target: '_blank', rel: 'noopener noreferrer' }, short(p.tx)) : h('span.mono', short(p.tx)))))))) : h('p.small.muted', 'No payouts to this wallet yet. Trade Elpida V2 tokens on at least two days in a round to qualify.'));
      } catch (e) { out.replaceChildren(h('p.error-text', { role: 'alert' }, e.message)); }
    };
    return h('div.rw-lookup', h('form.rw-lookup-form', { on: { submit: e => { e.preventDefault(); go(); } } }, input, h('button.btn.btn-secondary', { type: 'submit' }, 'Check payouts')), out);
  }

  function flywheel(chain) {
    const f = chain.flywheel;
    if (!f) return null;
    return h('div.rw-flywheel',
      h('div.analytics-summary',
        tile('Cycles', number(f.cycles, 0), 'Buy-and-burn rounds run', 'refresh-cw'),
        tile('Spent', f.spentByAsset.length ? f.spentByAsset.map(s => headline(chain, s.asset, s.amount)).join(' · ') : '0', [f.spentByAsset.map(s => sub(chain, s.asset, s.amount)).filter(Boolean).join(' · '), 'From the flywheel vault only'].filter(Boolean).join(' · '), 'flame'),
        tile('Tokens burned', number(f.burnedByToken.length, 0), 'Supply reduced with burn()', 'sparkles')),
      f.burns.length ? h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Token', 'Spent', 'Burned', 'Supply after', 'When'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', ...f.burns.map(b => h('tr', h('td', h('a', { href: `#/token/${b.token}?network=${encodeURIComponent(chain.key)}` }, short(b.token))), h('td', money(chain, b.asset, b.spent)), h('td', compact(units(b.burned))),
          h('td', compact(units(b.supplyAfter))), h('td', chain.explorer ? h('a.mono', { href: `${chain.explorer}/tx/${b.tx}`, target: '_blank', rel: 'noopener noreferrer' }, dateOf(b.time)) : dateOf(b.time))))))) : h('p.small.muted', 'No buy-and-burn cycle has run yet.'));
  }

  const tile = (title, value, note, glyph) => h('div.tile.analytics-metric', h('p.an-tile-label', icon(glyph, 'icon-sm'), title), h('strong', value), h('p.small.muted', note));

  function draw() {
    const chain = data.chains.find(c => c.key === chainKey) ?? data.chains[0];
    chainKey = chain.key;
    const picker = data.chains.length > 1 ? h('select', { 'aria-label': 'Rewards chain', on: { change: e => { chainKey = e.target.value; draw(); } } }, ...data.chains.map(c => h('option', { value: c.key, selected: c.key === chainKey }, c.name))) : null;
    root.replaceChildren(
      h('div.analytics-section-head', h('div', h('h2', { id: 'rw-title' }, 'Rewards'), h('p.small.muted', `Where every fee goes on ${chain.name}: 30% creator, 30% trader airdrop, 10% flywheel, 10% holder rewards, 20% treasury. Read from the contracts.`)), h('div.analytics-controls', picker, h('span.badge', 'Test network · no monetary value'))),
      h('div.rw-countdowns', countdownCard(chain, 'airdrop', 'Trader airdrop'), countdownCard(chain, 'holder', 'Holder rewards')),
      vaultTiles(chain),
      h('div.rw-block', h('h3', 'Vault sizes by day'), h('p.small.muted', 'Earned from fees so far, less what has been paid out or burned. Updated as trades confirm.'), sizeChart(chain)),
      h('div.rw-block', h('h3', 'How the last airdrop was shared'), h('p.small.muted', 'Each month: 20% of the pool equally among qualifying traders, 40% by the square root of fees paid, 40% in proportion to fees paid; no trader above 1% of the pool. Linked wallets count as one trader; creator-linked wallets are excluded.'), distribution(chain)),
      h('div.rw-block', h('h3', 'Check your payouts'), lookup()),
      h('div.rw-block', h('h3', 'Flywheel buy-and-burn'), h('p.small.muted', 'The flywheel vault can only buy Elpida V2 tokens and burn them. The treasury never holds its funds.'), flywheel(chain)));
    root.hidden = false;
    tick();
  }

  async function load() {
    try {
      const next = await api('public/v2-rewards');
      if (!next?.deployed || !next.chains?.length) { root.hidden = true; root.replaceChildren(); return; }
      data = next; draw();
    } catch { if (!data) root.hidden = true; }
  }

  load();
  ticker = setInterval(() => { if (root.isConnected && !document.hidden && !root.hidden) tick(); }, 1000);
  timer = setInterval(() => { if (root.isConnected && !document.hidden) load(); }, 60_000);
  return { root, dispose: () => { clearInterval(ticker); clearInterval(timer); } };
}
