import { h, icon, number, compact, short } from './ui.mjs';

// Analytics page, Rewards section (ELPIDA V2.0), every chain together. Everything here is read from the V2 contracts by
// the server's rewards index (/api/public/v2-rewards): vault sizes by day, the airdrop and holder-reward rounds and
// their countdowns, how each round was distributed, and the flywheel's burns. Vaults hold different assets on each
// chain (ETH, BNB, USDC, stocks), so totals are in dollars where the asset has a fresh price and the per-asset amounts
// are listed beside them; an asset without a price is shown in its own units and never converted. With no V2
// deployment the section stays hidden: no placeholder figures. Countdowns tick in the page against the round end the
// contracts fixed; chains whose rounds end together share one countdown.

const SVG = 'http://www.w3.org/2000/svg';
const VAULTS = [
  { key: 'airdrop', label: 'Trader airdrop', share: '30% of every fee', glyph: 'gift' },
  { key: 'holder', label: 'Holder rewards', share: '10% of every fee', glyph: 'users' },
  { key: 'flywheel', label: 'Flywheel', share: '10% of every fee', glyph: 'flame' },
];
const DAY = 86_400;

/** Base units (decimal string) to a display number. Rewards stay far below 2^53 display units. */
const units = (value, decimals = 18) => Number(BigInt(value ?? 0)) / 10 ** decimals;
const pad = n => String(n).padStart(2, '0');
const dateOf = t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeOf = t => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const usdText = n => '$' + (n < 1 ? n.toFixed(n > 0 && n < 0.01 ? 4 : 2) : compact(n));
/** Fixed colour per chain (identity, not rank). Mainnet keys share their testnet's colour. */
const chainColor = key => /^base/.test(key) ? 'base' : /^bnb/.test(key) ? 'bnb' : /^ethereum/.test(key) ? 'ethereum' : /^solana/.test(key) ? 'solana' : 'other';
const names = list => list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

const assetOf = (chain, address) => chain.assets?.[address] ?? chain.assets?.[String(address).toLowerCase()] ?? { symbol: short(address), decimals: 18, usd: null };
/** One holding on one chain: its display amount, and dollars when the asset is priced. */
function holding(chain, address, value) {
  const a = assetOf(chain, address), n = units(value, a.decimals);
  return { n, symbol: a.symbol, text: `${number(n, n < 1 ? 6 : 4)} ${a.symbol}`, usd: a.usd ? n * a.usd : null };
}

/**
 * Adds up holdings from several chains: dollars for priced assets, and per-symbol amounts for everything (so ETH on
 * Base Sepolia and on Ethereum Sepolia read as one ETH figure). Returns the headline and its detail line.
 */
export function combine(items) {
  let usd = 0, priced = 0;
  const bySymbol = new Map();
  for (const m of items) {
    if (!(m.n > 0)) continue;
    if (m.usd !== null) { usd += m.usd; priced++; }
    const s = bySymbol.get(m.symbol) ?? { n: 0, unpriced: false };
    s.n += m.n; s.unpriced ||= m.usd === null; bySymbol.set(m.symbol, s);
  }
  const amounts = [...bySymbol].map(([symbol, s]) => `${number(s.n, s.n < 1 ? 6 : 4)} ${symbol}`);
  const unpriced = [...bySymbol].filter(([, s]) => s.unpriced).map(([symbol, s]) => `${number(s.n, s.n < 1 ? 6 : 4)} ${symbol}`);
  if (priced) return { headline: usdText(usd), detail: amounts.join(' · '), usd, extra: priced < items.filter(m => m.n > 0).length ? unpriced : [] };
  if (amounts.length) return { headline: amounts[0], detail: amounts.slice(1).join(' · '), usd: null, extra: [] };
  return { headline: '$0', detail: '', usd: 0, extra: [] };
}

export function rewardsSection({ api }) {
  const root = h('section.panel.rw-section', { hidden: true, 'aria-labelledby': 'rw-title' });
  let data = null, ticker = null, timer = null;

  const chains = () => data.chains;
  const chainOf = key => data.chains.find(c => c.key === key) ?? { assets: {}, name: key };
  const money = (chain, address, value) => {
    const m = holding(chain, address, value);
    return m.usd === null ? h('span', m.text) : h('span', h('span', usdText(m.usd)), h('span.small.muted', ` · ${m.text}`));
  };
  const chainTag = chain => h('span.badge.rw-chain', chain.name);

  /** One countdown per distinct round end; chains whose rounds end together share it. */
  function countdownCards(kind, title) {
    const groups = new Map();
    for (const chain of chains()) {
      const c = chain[kind]?.countdown;
      if (!c?.started) continue;
      const g = groups.get(c.endsAt) ?? { c, names: [] };
      g.names.push(chain.name); groups.set(c.endsAt, g);
    }
    return [...groups.values()].sort((a, b) => a.c.endsAt - b.c.endsAt).map(({ c, names: on }) => {
      const cells = ['days', 'hours', 'minutes', 'seconds'].map(k => h('div.rw-cd-cell', h('strong', { 'data-part': k }, '--'), h('span', k)));
      const where = groups.size > 1 ? ` on ${names(on)}` : '';
      return h('div.rw-countdown', { 'data-ends': String(c.endsAt), 'data-starts': String(c.startedAt) },
        h('div.rw-countdown-head', h('p.an-tile-label', icon(kind === 'airdrop' ? 'gift' : 'users', 'icon-sm'), title), h('span.badge', `Round ${c.round + 1}`)),
        h('div.rw-cd', { role: 'timer', 'aria-live': 'off', 'aria-label': `${title} round ends ${dateTimeOf(c.endsAt)}${where}` }, ...cells),
        h('div.rw-progress', h('span.rw-progress-fill')),
        h('p.small.muted', `Ends ${dateTimeOf(c.endsAt)}${where}. ${kind === 'airdrop' ? 'Payouts are posted on chain after it ends.' : 'Holder rewards are paid each round.'}`));
    });
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

  /** Every chain's holdings of one vault, now and a week ago. */
  const vaultHoldings = (kind, ago = 0) => chains().flatMap(chain => (chain[kind]?.assets ?? []).map(a => {
    const size = ago ? (a.series?.at(-1 - ago)?.size ?? '0') : a.size;
    return holding(chain, a.asset, size);
  }));

  function vaultTiles() {
    return h('div.analytics-metrics.rw-vaults', ...VAULTS.map(v => {
      const now = combine(vaultHoldings(v.key)), week = combine(vaultHoldings(v.key, 7));
      const growth = now.usd !== null && week.usd !== null && now.usd - week.usd > 0.005 ? ` · +${usdText(now.usd - week.usd)} in 7 days` : '';
      return h('div.tile.analytics-metric', { 'data-hl': v.key === 'airdrop' ? 'true' : null },
        h('p.an-tile-label', icon(v.glyph, 'icon-sm'), v.label),
        h('strong', now.headline),
        now.detail ? h('p.small', now.detail) : null,
        h('p.small.muted', `${v.share}${growth}`),
        now.extra.length ? h('p.small.muted', `Not priced: ${now.extra.join(' · ')}`) : null);
    }));
  }

  /**
   * The pool by chain: a donut of each chain's share of the dollar total (all three vaults), beside a table of every
   * chain's holdings. Chain colours follow the chain, never its rank. Solana is listed until its V2 rewards exist.
   */
  function breakdown() {
    const rows = chains().map(chain => {
      const per = VAULTS.map(v => ({ v, c: combine((chain[v.key]?.assets ?? []).map(a => holding(chain, a.asset, a.size))) }));
      const all = combine(VAULTS.flatMap(v => (chain[v.key]?.assets ?? []).map(a => holding(chain, a.asset, a.size))));
      return { chain, per, all, usd: all.usd ?? 0 };
    });
    const total = rows.reduce((n, r) => n + r.usd, 0);
    const share = r => total > 0 ? r.usd / total : 0;
    const pct = r => total > 0 ? `${number(share(r) * 100, share(r) < 0.1 ? 1 : 0)}%` : '—';
    // Donut: one ring segment per chain with value, a 2px surface gap between segments.
    const R = 52, C = 2 * Math.PI * R, GAP = 2;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 140 140'); svg.setAttribute('class', 'rw-donut'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', total > 0 ? `Reward pool by chain: ${rows.filter(r => r.usd > 0).map(r => `${r.chain.name} ${pct(r)}`).join(', ')}` : 'Reward pool by chain: no fees yet');
    const ring = document.createElementNS(SVG, 'circle');
    for (const [k, v] of Object.entries({ cx: 70, cy: 70, r: R, class: 'rw-donut-track' })) ring.setAttribute(k, v);
    svg.append(ring);
    let offset = 0;
    const live = rows.filter(r => r.usd > 0);
    for (const r of live) {
      const len = share(r) * C, seg = document.createElementNS(SVG, 'circle');
      const visible = live.length > 1 ? Math.max(0.5, len - GAP) : len;
      for (const [k, v] of Object.entries({ cx: 70, cy: 70, r: R, class: `rw-donut-seg rw-c-${chainColor(r.chain.key)}`, 'stroke-dasharray': `${visible} ${C - visible}`, 'stroke-dashoffset': String(-offset), transform: 'rotate(-90 70 70)' })) seg.setAttribute(k, v);
      const tip = document.createElementNS(SVG, 'title'); tip.textContent = `${r.chain.name}: ${usdText(r.usd)} (${pct(r)})`; seg.append(tip);
      svg.append(seg); offset += len;
    }
    const centre = h('div.rw-donut-centre', h('strong', usdText(total)), h('span', 'all chains'));
    const table = h('table.analytics-table.rw-breakdown-table', h('thead', h('tr', ...['Chain', 'Pool', 'Share', ...VAULTS.map(v => v.label)].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', ...rows.map(r => h('tr',
        h('td', h('span.rw-chain-name', h('i', { class: `rw-swatch rw-c-${chainColor(r.chain.key)}`, 'aria-hidden': 'true' }), r.chain.name)),
        h('td', h('strong', r.all.headline), r.all.detail ? h('p.small.muted', r.all.detail) : null),
        h('td', pct(r)),
        ...r.per.map(({ c }) => h('td', c.headline, c.detail ? h('p.small.muted', c.detail) : null)))),
        h('tr.rw-pending', h('td', h('span.rw-chain-name', h('i', { class: 'rw-swatch rw-c-solana', 'aria-hidden': 'true' }), 'Solana')), h('td', { colspan: String(2 + VAULTS.length) }, h('span.small.muted', 'Not live yet. Solana joins the pool when Elpida V2 launches there.')))));
    return h('div.rw-breakdown', h('div.rw-donut-wrap', svg, centre), h('div.analytics-table-scroll', table));
  }

  /** Daily vault sizes in dollars, every chain and priced asset added together; one line per vault. */
  function sizeChart() {
    const lines = VAULTS.map(v => {
      const total = new Map();
      for (const chain of chains()) for (const a of chain[v.key]?.assets ?? []) {
        const meta = assetOf(chain, a.asset);
        if (!meta.usd) continue;
        for (const p of a.series ?? []) total.set(p.day, (total.get(p.day) ?? 0) + units(p.size, meta.decimals) * meta.usd);
      }
      return { ...v, total };
    }).filter(l => l.total.size);
    if (!lines.length) {
      const any = VAULTS.some(v => vaultHoldings(v.key).some(m => m.n > 0));
      return h('p.small.muted', any ? 'The vaults hold only assets without a fresh price, so there is no dollar chart yet. Their amounts are above.' : 'No fees have reached the vaults yet. Vaults fill from trades of Elpida V2 tokens.');
    }
    // Each series already runs to the server's today, so the last day is the latest one any chain reported.
    const all = lines.flatMap(l => [...l.total.keys()]), first = Math.min(...all), last = Math.max(...all);
    const days = []; for (let d = first; d <= Math.max(first, last); d += DAY) days.push(d);
    // Carry each vault's last size forward over days a chain had no event, so lines never dip to zero between events.
    for (const l of lines) { let prev = 0; l.points = days.map(d => { if (l.total.has(d)) prev = l.total.get(d); return { day: d, usd: prev }; }); }
    const span = Math.max(1, days.at(-1) - first), max = Math.max(1e-9, ...lines.flatMap(l => l.points.map(p => p.usd)));
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 900 220'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Vault sizes in dollars by day, ${dateOf(first)} to ${dateOf(days.at(-1))}`);
    for (let i = 0; i < 4; i++) { const g = document.createElementNS(SVG, 'line'); for (const [k, v] of Object.entries({ x1: 0, x2: 900, y1: 20 + i * 60, y2: 20 + i * 60 })) g.setAttribute(k, v); g.setAttribute('class', 'analytics-gridline'); svg.append(g); }
    for (const l of lines) {
      const pts = l.points.map(p => `${days.length === 1 ? 450 : (p.day - first) / span * 900},${200 - p.usd / max * 180}`);
      const line = document.createElementNS(SVG, 'polyline'); line.setAttribute('points', pts.join(' ')); line.setAttribute('class', `rw-line rw-line-${l.key}`); svg.append(line);
    }
    const legend = h('div.rw-legend', ...lines.map(l => h('span', h('i', { class: `rw-swatch rw-swatch-${l.key}`, 'aria-hidden': 'true' }), l.label)));
    return h('div.analytics-plot', svg, h('div.analytics-axis', h('span', dateOf(first)), h('span', `Peak ${usdText(max)}`), h('span', dateOf(days.at(-1)))), legend);
  }

  function distribution() {
    const rounds = chains().flatMap(chain => (chain.airdrop?.rounds ?? []).map(r => ({ ...r, chain }))).sort((a, b) => b.postedAt - a.postedAt);
    if (!rounds.length) return h('div.rw-empty', h('p', 'No airdrop round has been paid yet.'), h('p.small.muted', 'The first payouts are posted on chain when the current round ends.'));
    // The latest round number, every chain and asset it was paid in. Shares and bands come from the largest of them.
    const latest = rounds.filter(r => r.round === rounds[0].round), lead = [...latest].sort((a, b) => b.recipients - a.recipients)[0];
    const s = lead.stats, chain = lead.chain, maxBand = Math.max(1, ...s.bands.map(b => b.count));
    const pool = combine(latest.map(r => holding(r.chain, r.asset, r.total)));
    const one = (value) => { const m = holding(chain, lead.asset, value); return m.usd === null ? m.text : usdText(m.usd); };
    return h('div.rw-distribution',
      h('div.analytics-summary',
        tile('Traders paid', `${number(latest.reduce((n, r) => n + r.paidRecipients, 0), 0)} of ${number(latest.reduce((n, r) => n + r.recipients, 0), 0)}`, `Round ${lead.round + 1} · ${dateOf(lead.start)}–${dateOf(lead.end - 1)} · pool ${pool.headline}`, 'users'),
        tile('Median payout', one(s.median), latest.length > 1 ? `${chain.name}, the largest round · half of traders received more` : 'Half of traders received more', 'percent'),
        tile('Smallest / largest', `${one(s.smallest)} / ${one(s.largest)}`, 'No trader above 1% of the pool', 'arrow-down-up'),
        tile('Top 1% of traders', `${number(s.top1Share * 100, 1)}%`, 'Share of what was paid', 'chart-column')),
      h('div.rw-bands', { role: 'list', 'aria-label': `Payouts by size, ${chain.name}` }, ...s.bands.map(b => {
        const fill = h('span.rw-band-fill'); fill.style.width = `${(b.count / maxBand * 100).toFixed(1)}%`;
        return h('div.rw-band', { role: 'listitem' }, h('span.rw-band-label', `${b.label} ${assetOf(chain, lead.asset).symbol}`), h('span.rw-band-bar', fill), h('span.rw-band-count', number(b.count, 0)));
      })),
      h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Round', 'Chain', 'Pool', 'Traders', 'Paid', 'Unclaimed', 'Posted'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', ...rounds.map(x => h('tr', h('td', `Round ${x.round + 1}`, h('p.small.muted', `${dateOf(x.start)}–${dateOf(x.end - 1)}`)), h('td', chainTag(x.chain)), h('td', money(x.chain, x.asset, x.total)), h('td', number(x.recipients, 0)), h('td', number(x.paidRecipients, 0), x.failed ? h('p.small.muted', `${x.failed} transfer${x.failed === 1 ? '' : 's'} to retry`) : null),
          h('td', x.expired ? 'Returned to the pool' : holding(x.chain, x.asset, x.unclaimed).text), h('td', x.chain.explorer ? h('a.mono', { href: `${x.chain.explorer}/tx/${x.postTx}`, target: '_blank', rel: 'noopener noreferrer' }, dateOf(x.postedAt)) : dateOf(x.postedAt))))))));
  }

  function lookup() {
    const input = h('input.input', { placeholder: '0x… your wallet', spellcheck: false, autocomplete: 'off', 'aria-label': 'Wallet address' });
    const out = h('div.rw-lookup-out', { 'aria-live': 'polite' });
    const go = async () => {
      out.replaceChildren(h('p.small.muted', 'Checking…'));
      try {
        const r = await api(`public/v2-rewards/payouts?wallet=${encodeURIComponent(input.value.trim())}`);
        const rows = r.chains.flatMap(c => c.payouts.map(p => ({ ...p, chain: chainOf(c.key) }))).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
        out.replaceChildren(rows.length ? h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Received', 'Chain', 'Reward', 'Round', 'Transaction'].map(t => h('th', { scope: 'col' }, t)))),
          h('tbody', ...rows.map(p => h('tr', h('td', money(p.chain, p.asset, p.amount)), h('td', chainTag(p.chain)), h('td', p.kind === 'airdrop' ? 'Trader airdrop' : 'Holder rewards'), h('td', `Round ${p.round + 1}`),
            h('td', p.chain.explorer ? h('a.mono', { href: `${p.chain.explorer}/tx/${p.tx}`, target: '_blank', rel: 'noopener noreferrer' }, short(p.tx)) : h('span.mono', short(p.tx)))))))) : h('p.small.muted', 'No payouts to this wallet yet. Trade Elpida V2 tokens on at least two days in a round to qualify.'));
      } catch (e) { out.replaceChildren(h('p.error-text', { role: 'alert' }, e.message)); }
    };
    return h('div.rw-lookup', h('form.rw-lookup-form', { on: { submit: e => { e.preventDefault(); go(); } } }, input, h('button.btn.btn-secondary', { type: 'submit' }, 'Check payouts')), out);
  }

  function flywheel() {
    const all = chains().filter(c => c.flywheel);
    if (!all.length) return null;
    const burns = all.flatMap(chain => chain.flywheel.burns.map(b => ({ ...b, chain }))).sort((a, b) => b.time - a.time).slice(0, 50);
    const spent = combine(all.flatMap(chain => chain.flywheel.spentByAsset.map(s => holding(chain, s.asset, s.amount))));
    return h('div.rw-flywheel',
      h('div.analytics-summary',
        tile('Cycles', number(all.reduce((n, c) => n + c.flywheel.cycles, 0), 0), 'Buy-and-burn rounds run', 'refresh-cw'),
        tile('Spent', spent.headline, [spent.detail, 'From the flywheel vault only'].filter(Boolean).join(' · '), 'flame'),
        tile('Tokens burned', number(all.reduce((n, c) => n + c.flywheel.burnedByToken.length, 0), 0), 'Supply reduced with burn()', 'sparkles')),
      burns.length ? h('div.analytics-table-scroll', h('table.analytics-table', h('thead', h('tr', ...['Token', 'Chain', 'Spent', 'Burned', 'Supply after', 'When'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', ...burns.map(b => h('tr', h('td', h('a', { href: `#/token/${b.token}?network=${encodeURIComponent(b.chain.key)}` }, short(b.token))), h('td', chainTag(b.chain)), h('td', money(b.chain, b.asset, b.spent)), h('td', compact(units(b.burned))),
          h('td', compact(units(b.supplyAfter))), h('td', b.chain.explorer ? h('a.mono', { href: `${b.chain.explorer}/tx/${b.tx}`, target: '_blank', rel: 'noopener noreferrer' }, dateOf(b.time)) : dateOf(b.time))))))) : h('p.small.muted', 'No buy-and-burn cycle has run yet.'));
  }

  const tile = (title, value, note, glyph) => h('div.tile.analytics-metric', h('p.an-tile-label', icon(glyph, 'icon-sm'), title), h('strong', value), h('p.small.muted', note));

  function draw() {
    const on = chains().map(c => c.name);
    root.replaceChildren(
      h('div.analytics-section-head', h('div', h('h2', { id: 'rw-title' }, 'Rewards'), h('p.small.muted', `Where every fee goes, on ${names(on)} together: 30% creator, 30% trader airdrop, 10% flywheel, 10% holder rewards, 20% treasury. Read from the contracts.`)), h('div.analytics-controls', h('span.badge', 'Test networks · no monetary value'))),
      h('div.rw-countdowns', ...countdownCards('airdrop', 'Trader airdrop'), ...countdownCards('holder', 'Holder rewards')),
      vaultTiles(),
      h('div.rw-block', h('h3', 'Reward pool by chain'), h('p.small.muted', 'One pool across every chain. Each chain\'s share of what the trader airdrop, holder rewards and flywheel vaults hold now, in dollars at today\'s prices.'), breakdown()),
      h('div.rw-block', h('h3', 'Vault sizes by day'), h('p.small.muted', 'Earned from fees so far on every chain, less what has been paid out or burned, in dollars at today\'s prices. Updated as trades confirm.'), sizeChart()),
      h('div.rw-block', h('h3', 'How the last airdrop was shared'), h('p.small.muted', 'Each month: 20% of the pool equally among qualifying traders, 40% by the square root of fees paid, 40% in proportion to fees paid; no trader above 1% of the pool. Linked wallets count as one trader; creator-linked wallets are excluded.'), distribution()),
      h('div.rw-block', h('h3', 'Check your payouts'), lookup()),
      h('div.rw-block', h('h3', 'Flywheel buy-and-burn'), h('p.small.muted', 'The flywheel vault can only buy Elpida V2 tokens and burn them. The treasury never holds its funds.'), flywheel()));
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
  timer = setInterval(() => { if (root.isConnected && !document.hidden) load(); }, 30_000);
  return { root, dispose: () => { clearInterval(ticker); clearInterval(timer); } };
}
