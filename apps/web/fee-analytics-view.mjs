import { h, icon, number, compact } from './ui.mjs';

// Analytics page, Fees and revenue section (analytics step 3, 14 Nov 2026), from /api/public/fees. Mainnet and test
// networks are never added together: the section shows one of them at a time (mainnet by default once any mainnet is
// indexed) and test figures carry "test, no value". Each figure says what it is in a definition beside it. Fees of
// older models are listed as not tracked rather than shown as zero.

const SHARES = [
  { key: 'creator', label: 'Creators', glyph: 'user-round' },
  { key: 'traderAirdrop', label: 'Trader airdrop', glyph: 'gift' },
  { key: 'holderRewards', label: 'Holder rewards', glyph: 'users' },
  { key: 'flywheel', label: 'Flywheel', glyph: 'flame' },
  { key: 'treasury', label: 'Elpida treasury', glyph: 'circle-dollar-sign' },
  { key: 'buybackBurn', label: 'Partner buyback burn', glyph: 'flame', optional: true },
];
const DEFINITIONS = {
  fees: 'V2: the fee in every confirmed trade, from the hook\'s Fee event. Model 10 curves: the 1.25% base fee of every curve trade, recomputed exactly as the curve charges it (the anti-snipe surplus is locked liquidity, not a fee). Selected period.',
  revenue: 'Launch fees paid to the factory, plus the treasury\'s 20% of V2 fees and Elpida\'s half of Model 10 curve fees. Nothing else: reserves, deposits and reward pools are not revenue.',
  creators: 'Creator fees sent out in the selected period: by the V2 hook to creator wallets and allocation vaults, and by Model 10 curves to the creator\'s reward vault.',
  launch: 'Launch fees from the factory\'s LaunchFeePaid events. USDC at face value; native coins at the price of the hour paid.',
};
const MODELS = { v1: 'V1', 'model-10': 'Model 10 (other)', 'curve-tax-v10': 'Model 10 tax curves', 'curve-dex-v9': 'Model 9 curves', 'curve-beta-v8': 'Model 8 curves', 'v4-hook': 'Model 11', 'solana-curve': 'Solana curves' };
const SPLIT = { creator: '30% V2 · 50% M10', traderAirdrop: '30% V2', holderRewards: '10% V2', flywheel: '10% V2', treasury: '20% V2 · 50% M10', buybackBurn: 'part of M10 Elpida half' };
const usd = n => n > 0 && n < 1 ? '$' + n.toFixed(n < 0.01 ? 4 : 2) : n < 1000 ? '$' + Math.round(n).toLocaleString() : '$' + compact(n);

export function feesSection({ api }) {
  let scope = null, data = null, revision = 0, period = '7d', network = 'all';
  const root = h('section.panel.analytics-fees', { hidden: true }), status = h('p.small.muted', { role: 'status' });
  const scopes = h('div.analytics-filters', { 'aria-label': 'Mainnet or test networks' });
  function tile(title, value, note, glyph, definition) {
    return h('div.tile.analytics-metric', h('p.an-tile-label', icon(glyph, 'icon-sm'), title), h('strong', value), h('p.small.muted', note),
      h('details.analytics-definition', h('summary', 'What this counts'), h('p.small', definition)));
  }
  function monthsTable(g, tag) {
    if (!g.months?.length) return null;
    return [h('h3', 'By month'), h('div.analytics-table-scroll', h('table.analytics-table', h('caption.visually-hidden', `Fees and revenue by calendar month (UTC)${tag}`),
      h('thead', h('tr', ...['Month (UTC)', 'Fees generated', 'Elpida revenue', 'of which launch fees', 'Creators\' share', 'Paid out'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', g.months.map(m => h('tr', h('th', { scope: 'row' }, new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })),
        ...['feesUsd', 'revenueUsd', 'launchFeesUsd', 'creatorUsd', 'withdrawnUsd'].map(k => h('td', usd(m[k]))))))))];
  }
  function draw() {
    const hasMainnet = data.networks.some(n => n.mainnet);
    if (network !== 'all' && data.networks[0]) scope = data.networks[0].mainnet ? 'mainnet' : 'testnet';
    scope ??= hasMainnet ? 'mainnet' : 'testnet';
    scopes.replaceChildren(...['mainnet', 'testnet'].map(s => h('button.btn.btn-secondary.btn-sm', { type: 'button', 'aria-pressed': String(s === scope), disabled: s === 'mainnet' && !hasMainnet ? true : null,
      on: { click: () => { scope = s; draw(); } } }, s === 'mainnet' ? (hasMainnet ? 'Mainnet' : 'Mainnet · not live yet') : 'Test networks')));
    const g = data[scope], test = scope === 'testnet', tag = test ? ' · test, no value' : '';
    const nets = data.networks.filter(n => n.mainnet === !test), v2 = nets.reduce((s, n) => s + n.v2Tokens, 0), m10 = nets.reduce((s, n) => s + (n.model10Tokens ?? 0), 0);
    const valued = g.valuation, revalued = valued.revalued ? `${number(valued.revalued)} amounts valued at today's price (no hourly price recorded yet)` : null;
    const rows = SHARES.filter(s => !s.optional || g.shares[s.key]?.earnedUsd || g.shares[s.key]?.withdrawnUsd).map(s => {
      const x = g.shares[s.key];
      return h('tr', h('th', { scope: 'row' }, icon(s.glyph, 'icon-sm'), ` ${s.label}`, h('span.small.muted.share-basis', SPLIT[s.key])),
        h('td', usd(x.earnedUsd)), h('td', usd(x.withdrawnUsd), x.failedPayouts ? h('p.small.muted', `${number(x.failedPayouts)} failed payouts, retried by the hook`) : null), h('td', usd(x.outstandingUsd)));
    });
    const untracked = g.untracked.reduce((m, u) => m.set(u.model, (m.get(u.model) ?? 0) + u.tokens), new Map());
    root.replaceChildren(
      h('div.analytics-section-head', h('div', h('h2', 'Fees and revenue'), h('p.small.muted', `${number(v2)} V2 and ${number(m10)} Model 10 tokens on ${nets.length} ${test ? 'test ' : ''}network${nets.length === 1 ? '' : 's'}${tag}`)), scopes),
      status,
      h('div.analytics-metrics',
        tile('Trading fees generated', usd(g.feesGeneratedUsd), `${number(g.trades)} trades · selected period${tag}`, 'coins', DEFINITIONS.fees),
        tile('Elpida revenue', usd(g.revenueUsd), `${usd(g.launchFeesUsd)} launch fees + ${usd(g.shares.treasury.earnedUsd)} trading-fee share${tag}`, 'circle-dollar-sign', DEFINITIONS.revenue),
        tile('Paid to creators', usd(g.shares.creator.withdrawnUsd), `of ${usd(g.shares.creator.earnedUsd)} earned · selected period${tag}`, 'user-round', DEFINITIONS.creators),
        tile('Launch fees', usd(g.launchFeesUsd), `${number(g.launches)} launches paid · selected period${tag}`, 'sparkles', DEFINITIONS.launch)),
      h('h3', 'Where the fees went'),
      h('p.small.muted', 'Earned is each share of the fees generated in the period. Claimed is what the V2 hook or a Model 10 curve paid out to each share in the period. In vault is what they still hold for it today, at today\'s price. The columns are never added together.'),
      h('div.analytics-table-scroll', h('table.analytics-table', h('caption.visually-hidden', `V2 fee shares${tag}`),
        h('thead', h('tr', ...['Share', 'Earned', 'Claimed', 'In vault'].map(t => h('th', { scope: 'col' }, t)))), h('tbody', rows))),
      h('p.small.muted', [['v2', 'V2'], ['model10', 'Model 10 curves']].filter(([k]) => g.byModel?.[k]).map(([k, label]) => `${label}: ${usd(g.byModel[k].feesGeneratedUsd)} from ${number(g.byModel[k].trades)} trades`).join(' · ') || null),
      ...(monthsTable(g, tag) ?? []),
      untracked.size ? h('p.small.muted', `Graduated Model 10 pools' LP fees are not counted yet. Not tracked here yet: ${[...untracked].map(([m, n]) => `${MODELS[m] ?? m} (${number(n)} token${n === 1 ? '' : 's'})`).join(', ')}. Their fees follow different rules and are not estimated.`) : null,
      h('p.small.muted', [revalued, valued.unpriced ? `${number(valued.unpriced)} amounts have no USD price and are left out of dollar totals` : null, data.pricesSince ? `Hourly prices recorded since ${new Date(data.pricesSince * 1000).toLocaleString()}` : null].filter(Boolean).join('. ') || null));
    root.hidden = false;
  }
  async function load(nextPeriod = period, nextNetwork = network) {
    period = nextPeriod; network = nextNetwork;
    const id = ++revision;
    try {
      const next = await api(`public/fees?period=${period}&network=${encodeURIComponent(network)}`);
      if (id !== revision) return;
      data = next; status.textContent = ''; draw();
    } catch (e) {
      if (id !== revision) return;
      if (data) status.textContent = `Fees could not be updated. ${e.message}`; else root.hidden = true;
    }
  }
  return { root, load };
}
