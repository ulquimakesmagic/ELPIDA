import { h, icon, number } from './ui.mjs';
import { combine, holdingOf } from './v2-rewards-view.mjs';

// Analytics page headline (Malik, 10 November): where Elpida's fees go, at a glance, above everything else. Four large
// tiles from the V2 contracts (paid to holders, earned by creators, flywheel buybacks, the airdrop vault) and four
// small ones (V2 fees, coins launched, graduated, stock pairs in use). Every figure is read from chain data the server
// already indexes; a tile whose source is not deployed is left out rather than shown as zero. Dollar figures need a
// fresh price; otherwise the asset amount is shown.

/** The headline's figures from /api/public/v2-rewards (`rewards`, or null) and /api/public/analytics (`analytics`). */
export function headlineFigures(rewards, analytics) {
  const chains = rewards?.deployed ? rewards.chains ?? [] : [];
  // Dollars only; an asset with no fresh price is named under the figure instead of being shown in its own units.
  const sum = pick => { const c = combine(chains.flatMap(ch => pick(ch).map(([asset, value]) => holdingOf(ch, asset, value)))); return { ...c, detail: c.extra.length ? `Not in the total until priced: ${c.extra.join(', ')}` : '' }; };
  const out = { large: [], small: [] };
  if (chains.length) {
    const paid = sum(c => (c.holder?.rounds ?? []).map(r => [r.asset, r.claimed])), waiting = sum(c => (c.holder?.assets ?? []).map(a => [a.asset, a.size]));
    out.large.push({ key: 'holders', title: 'Paid to holders', value: paid.headline, note: `${waiting.headline} more waiting in the holder vault`, detail: paid.detail, glyph: 'users' });
    const creators = sum(c => (c.fees ?? []).map(f => [f.asset, f.creator]));
    out.large.push({ key: 'creators', title: 'Earned by creators', value: creators.headline, note: '30% of every V2 fee, paid to each coin\'s creator vault', detail: creators.detail, glyph: 'sparkles' });
    const spent = sum(c => (c.flywheel?.spentByAsset ?? []).map(s => [s.asset, s.amount])), burned = chains.reduce((n, c) => n + (c.flywheel?.burnedByToken ?? []).filter(b => BigInt(b.amount ?? 0) > 0n).length, 0);
    out.large.push({ key: 'flywheel', title: 'Flywheel buybacks', value: spent.headline, note: `${number(burned, 0)} ${burned === 1 ? 'coin' : 'coins'} bought and burned so far`, detail: spent.detail, glyph: 'flame', link: { label: 'See every burn', target: 'rw-flywheel' } });
    const vault = sum(c => (c.airdrop?.assets ?? []).map(a => [a.asset, a.size]));
    const symbols = new Set(chains.flatMap(c => (c.airdrop?.assets ?? []).filter(a => BigInt(a.size ?? 0) > 0n).map(a => holdingOf(c, a.asset, 0).symbol)));
    out.large.push({ key: 'airdrop', title: 'Airdrop vault', value: vault.headline, note: symbols.size === 1 && /USD/.test([...symbols][0]) ? `${[...symbols][0]} for qualifying traders` : 'For qualifying traders, paid monthly', detail: vault.detail, glyph: 'gift', link: { label: 'See every airdrop', target: 'rw-distribution' } });
    const fees = sum(c => (c.fees ?? []).map(f => [f.asset, f.total]));
    out.small.push({ key: 'fees', title: 'V2 fees collected', value: fees.headline });
  }
  const t = analytics?.totals;
  if (t) {
    out.small.push({ key: 'launched', title: 'Coins launched', value: number(t.tokens, 0) });
    out.small.push({ key: 'graduated', title: 'Graduated', value: number(t.graduated, 0) });
    const stocks = new Set((analytics.assets ?? []).filter(a => a.pair === 'xstock').map(a => a.key)).size;
    out.small.push({ key: 'stocks', title: 'Stock pairs in use', value: number(stocks, 0) });
  }
  return out;
}

/** The headline block; `update(rewards, analytics)` redraws it, hiding it while there is nothing to show. */
export function analyticsHeadline() {
  const root = h('section.an-headline', { hidden: true, 'aria-label': 'Where the fees go' });
  let rewards = null, analytics = null;
  const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  function draw() {
    const f = headlineFigures(rewards, analytics);
    if (!f.large.length && !f.small.length) { root.hidden = true; root.replaceChildren(); return; }
    root.hidden = false;
    root.replaceChildren(
      f.large.length ? h('div.an-headline-large', ...f.large.map(x => h('div.an-headline-tile', { 'data-key': x.key },
        h('p.an-tile-label', icon(x.glyph, 'icon-sm'), x.title), h('strong', x.value), h('p.small.muted', x.note),
        x.detail && x.detail !== x.value ? h('p.small.muted.an-headline-detail', x.detail) : null,
        x.link ? h('button.an-headline-link', { type: 'button', on: { click: () => scrollTo(x.link.target) } }, `${x.link.label} →`) : null))) : null,
      f.small.length ? h('div.an-headline-small', ...f.small.map(x => h('div.an-headline-stat', { 'data-key': x.key }, h('span', x.title), h('strong', x.value)))) : null,
      h('p.small.muted.an-headline-note', 'Test networks: test coins have no monetary value. Dollar figures use today\'s prices where a fresh price exists; other amounts are shown in their own units.'));
  }
  return { root, update(next) { if ('rewards' in next) rewards = next.rewards; if ('analytics' in next) analytics = next.analytics; draw(); } };
}
