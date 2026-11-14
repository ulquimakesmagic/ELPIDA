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
];
const DEFINITIONS = {
  fees: 'Sum of the fee in every confirmed V2 trade, read from the hook\'s Fee event, in the selected period.',
  revenue: 'Launch fees paid to the factory plus the treasury\'s 20% of V2 trading fees. Nothing else: reserves, deposits and reward pools are not revenue.',
  creators: 'The creators\' 30% share of V2 fees that the hook has sent to creator wallets and allocation vaults in the selected period.',
  launch: 'Launch fees from the factory\'s LaunchFeePaid events. USDC at face value; native coins at the price of the hour paid.',
};
const MODELS = { 'v1': 'V1', 'model-10': 'Model 10 curves', 'v4-hook': 'Model 11', 'solana-curve': 'Solana curves' };
const usd = n => n > 0 && n < 1 ? '$' + n.toFixed(n < 0.01 ? 4 : 2) : n < 1000 ? '$' + Math.round(n).toLocaleString() : '$' + compact(n);

export function feesSection({ api }) {
  let scope = null, data = null, revision = 0, period = '7d', network = 'all';
  const root = h('section.panel.analytics-fees', { hidden: true }), status = h('p.small.muted', { role: 'status' });
  const scopes = h('div.analytics-filters', { 'aria-label': 'Mainnet or test networks' });
  function tile(title, value, note, glyph, definition) {
    return h('div.tile.analytics-metric', h('p.an-tile-label', icon(glyph, 'icon-sm'), title), h('strong', value), h('p.small.muted', note),
      h('details.analytics-definition', h('summary', 'What this counts'), h('p.small', definition)));
  }
  function draw() {
    const hasMainnet = data.networks.some(n => n.mainnet);
    if (network !== 'all' && data.networks[0]) scope = data.networks[0].mainnet ? 'mainnet' : 'testnet';
    scope ??= hasMainnet ? 'mainnet' : 'testnet';
    scopes.replaceChildren(...['mainnet', 'testnet'].map(s => h('button.btn.btn-secondary.btn-sm', { type: 'button', 'aria-pressed': String(s === scope), disabled: s === 'mainnet' && !hasMainnet ? true : null,
      on: { click: () => { scope = s; draw(); } } }, s === 'mainnet' ? (hasMainnet ? 'Mainnet' : 'Mainnet · not live yet') : 'Test networks')));
    const g = data[scope], test = scope === 'testnet', tag = test ? ' · test, no value' : '';
    const nets = data.networks.filter(n => n.mainnet === !test), v2 = nets.reduce((s, n) => s + n.v2Tokens, 0);
    const valued = g.valuation, revalued = valued.revalued ? `${number(valued.revalued)} amounts valued at today's price (no hourly price recorded yet)` : null;
    const rows = SHARES.map(s => {
      const x = g.shares[s.key];
      return h('tr', h('th', { scope: 'row' }, icon(s.glyph, 'icon-sm'), ` ${s.label}`, h('span.small.muted', ` ${Math.round(data.split[s.key] * 100)}%`)),
        h('td', usd(x.earnedUsd)), h('td', usd(x.withdrawnUsd), x.failedPayouts ? h('p.small.muted', `${number(x.failedPayouts)} failed payouts, retried by the hook`) : null), h('td', usd(x.outstandingUsd)));
    });
    const untracked = g.untracked.reduce((m, u) => m.set(u.model, (m.get(u.model) ?? 0) + u.tokens), new Map());
    root.replaceChildren(
      h('div.analytics-section-head', h('div', h('h2', 'Fees and revenue'), h('p.small.muted', `${number(v2)} V2 tokens on ${nets.length} ${test ? 'test ' : ''}network${nets.length === 1 ? '' : 's'}${tag}`)), scopes),
      status,
      h('div.analytics-metrics',
        tile('Trading fees generated', usd(g.feesGeneratedUsd), `${number(g.trades)} V2 trades · selected period${tag}`, 'coins', DEFINITIONS.fees),
        tile('Elpida revenue', usd(g.revenueUsd), `${usd(g.launchFeesUsd)} launch fees + ${usd(g.shares.treasury.earnedUsd)} treasury share${tag}`, 'circle-dollar-sign', DEFINITIONS.revenue),
        tile('Paid to creators', usd(g.shares.creator.withdrawnUsd), `of ${usd(g.shares.creator.earnedUsd)} earned · selected period${tag}`, 'user-round', DEFINITIONS.creators),
        tile('Launch fees', usd(g.launchFeesUsd), `${number(g.launches)} launches paid · selected period${tag}`, 'sparkles', DEFINITIONS.launch)),
      h('h3', 'Where the fees went'),
      h('p.small.muted', 'Earned is each share of the fees generated in the period. Withdrawn is what the hook sent out in the period. Still owed is what the hook holds today, at today\'s price. The columns are never added together.'),
      h('div.analytics-table-scroll', h('table.analytics-table', h('caption.visually-hidden', `V2 fee shares${tag}`),
        h('thead', h('tr', ...['Share', 'Earned', 'Withdrawn', 'Still owed'].map(t => h('th', { scope: 'col' }, t)))), h('tbody', rows))),
      untracked.size ? h('p.small.muted', `Not tracked here yet: ${[...untracked].map(([m, n]) => `${MODELS[m] ?? m} (${number(n)} tokens)`).join(', ')}. Their fees follow different rules and are not estimated.`) : null,
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
