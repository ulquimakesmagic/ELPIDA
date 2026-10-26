import { h, icon, short, number, compact, avatar, pricing, fmtValue, progressOf, usdRate, bar, storage } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { holdingRows, withPosition, summarize, sumFees } from './portfolio-model.mjs';

// Portfolio: one summary bar, then Holdings (value, entry and P&L per token), Launched (curve, market cap and
// lifetime creator fees per launch) and Drafts. Every figure comes from the indexed state, `/api/terminal`
// (positions) or `/api/creator-fees`; anything not yet loaded shows a dash, never an estimate.

const TABS = [['holdings', 'Holdings'], ['launched', 'Launched'], ['drafts', 'Drafts']];
const LOAD_LIMIT = 30;
const href = t => `#/token/${t.address}${t.network ? '?network=' + encodeURIComponent(t.network) : ''}`;
const usd = v => { if (v === null || v === undefined || !Number.isFinite(v)) return '—'; const a = Math.abs(v); const sign = v < 0 ? '-' : ''; return a > 0 && a < 0.01 ? `${sign}<$0.01` : `${sign}$${a < 1000 ? number(a, 2) : compact(a)}`; };
const signed = v => v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${usd(v)}`;

/** Run `task` over `items` with at most `limit` in flight. */
async function each(items, limit, task) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; await task(items[i], i); } }));
}

export function portfolioView(ctx, { connect, rerender }) {
  const { state, mode } = ctx;
  const asked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab');
  const signedIn = mode !== 'testnet' || !!ctx.wallet?.address;
  const author = mode === 'testnet' ? ctx.wallet?.address : state.wallet;
  const network = ctx.currentChain();
  const tokens = state?.tokens ?? [];
  let rows = signedIn ? holdingRows(tokens, { price: t => pricing(t).price, rate: usdRate }) : [];
  const created = signedIn && state.wallet ? tokens.filter(t => t.creator?.toLowerCase() === state.wallet.toLowerCase()) : [];
  const draft = storage.get('elpida:launch-draft');
  const hasDraft = !!(draft && (draft.name || draft.symbol));
  const tab = TABS.some(([k]) => k === asked) ? asked : rows.length || !created.length ? 'holdings' : 'launched';
  const counts = { holdings: rows.length, launched: created.length, drafts: hasDraft ? 1 : 0 };

  // Summary bar: filled now from balances, then again as positions and creator fees arrive.
  const cell = (label, cls = '') => { const value = h('strong', '—'), note = h('small'); return { el: h(`div.tk-strip-tile${cls}`, h('span', label), h('strong.pf-sum', value, note)), value, note }; };
  const sum = { value: cell('Holdings value', '.tk-strip-cap'), pnl: cell('Unrealized P&L'), realized: cell('Realized P&L'), held: cell('Tokens held'), launched: cell('Launched'), fees: cell('Creator fees') };
  const feeLink = h('a.pf-claim', { href: '#/rewards' }, 'Claim', icon('arrow-right', 'icon-xs'));
  sum.fees.el.append(feeLink);
  const strip = h('section.tk-strip.pf-strip', { 'aria-label': 'Portfolio totals' }, ...Object.values(sum).map(c => c.el));
  function drawSummary() {
    const s = summarize(rows);
    sum.value.value.textContent = !signedIn ? '—' : s.value === null ? (rows.length ? 'No USD rate' : '$0') : usd(s.value);
    sum.value.note.textContent = signedIn && s.valueCovered && s.valueCovered < s.count ? ` ${s.valueCovered} of ${s.count}` : '';
    sum.pnl.value.textContent = signed(s.pnl);
    sum.pnl.value.dataset.dir = !s.pnl ? '' : s.pnl > 0 ? 'up' : 'down';
    sum.pnl.note.textContent = s.pnlPercent !== null ? ` ${s.pnlPercent >= 0 ? '+' : ''}${number(s.pnlPercent, 2)}%` : '';
    sum.pnl.note.dataset.dir = sum.pnl.value.dataset.dir;
    sum.realized.value.textContent = signed(s.realized);
    sum.realized.value.dataset.dir = !s.realized ? '' : s.realized > 0 ? 'up' : 'down';
    sum.held.value.textContent = signedIn ? String(rows.length) : '—';
    sum.launched.value.textContent = signedIn ? String(created.length) : '—';
  }
  drawSummary();

  const empty = (title, text, action) => h('div.pf-empty', h('span.pf-mark', icon('sprout')), h('h2', title), h('p', text), action);
  const connectAction = h('button.btn.btn-primary', { type: 'button', on: { click: connect } }, 'Connect wallet');
  const tokenCell = t => h('a.pf-token', { href: href(t) }, h('span.tk-avatar', avatar(t), h('span.tk-avatar-chain', chainIcon(t.network ?? network))), h('span.pf-name', h('strong', t.name), h('small', `$${t.symbol}`)));
  const change = t => { const c = t.priceChange24h; if (!c || !Number.isFinite(c.percent)) return h('span.muted', '—'); return h(`span.${c.percent >= 0 ? 'up' : 'down'}`, `${c.percent >= 0 ? '+' : ''}${number(c.percent, 2)}%`); };

  let body;
  const posCells = new Map(), feeCells = new Map();
  if (tab === 'drafts') {
    body = hasDraft ? h('div.pf-drafts', h('div.pf-draft', avatar({ symbol: draft.symbol || 'NEW', metadata: { image: draft.image } }), h('div', h('h3', draft.name || 'Untitled token'), h('span.sym.muted.small', draft.symbol ? `$${String(draft.symbol).toUpperCase()}` : 'No symbol yet'), h('p.small.muted', 'Saved in this browser for this session. It is not uploaded anywhere.')),
        h('div.pf-actions', h('a.btn.btn-primary.btn-sm', { href: '#/launch' }, 'Continue'), h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => { storage.remove('elpida:launch-draft'); rerender(); } } }, 'Discard'))))
      : empty('No drafts', 'Start a token and your progress is kept in this browser until you launch it.', h('a.btn.btn-primary', { href: '#/launch' }, icon('plus', 'icon-sm'), 'New token'));
  } else if (!signedIn) {
    body = empty('Nothing here yet', 'Connect your wallet to see the tokens you hold and launched.', connectAction);
  } else if (tab === 'holdings') {
    if (!rows.length) body = empty('No holdings yet', 'Tokens you buy appear here with their value, entry and profit or loss.', h('a.btn.btn-primary', { href: '#/' }, 'Explore tokens'));
    else {
      const tbody = h('tbody', rows.map(row => {
        const t = row.token, entry = h('td.num', { 'data-label': 'Avg entry MC' }, '—'), pnl = h('td.num', { 'data-label': 'P&L' }, h('span.muted', 'Loading…'));
        posCells.set(t.address.toLowerCase(), { entry, pnl, row });
        return h('tr.tk-row', h('td.pf-cell-token', tokenCell(t)), h('td.num', { 'data-label': 'Balance' }, `${compact(row.balance)}`), h('td.num.pf-cell-main', { 'data-label': 'Value' }, h('strong', fmtValue(row.value, t))), h('td.num', { 'data-label': 'Share' }, `${number(row.share, row.share < 0.01 ? 4 : 2)}%`), entry, pnl, h('td.num', { 'data-label': '24h' }, change(t)), h('td.num.pf-cell-action', h('a.btn.btn-secondary.btn-sm', { href: href(t) }, 'Trade')));
      }));
      body = h('div.tk-card.pf-card', h('div.table-scroll', h('table.market-table.tk-table.pf-table',
        h('thead', h('tr', ...['Token', 'Balance', 'Value', 'Share', 'Avg entry MC', 'Unrealized P&L', '24h', ''].map((label, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, label)))), tbody)),
        h('p.meta.pf-note', 'P&L uses the weighted-average cost of your indexed trades, without network gas. Tokens received by transfer have no known cost.'));
    }
  } else {
    if (!created.length) body = empty('Nothing launched yet', 'Your launches appear here with their curve progress, market cap and creator fees.', h('a.btn.btn-primary', { href: '#/launch' }, icon('plus', 'icon-sm'), 'Create token'));
    else {
      const status = t => { const pct = progressOf(t); return t.graduated ? h('span.pf-status.up', 'Graduated') : t.complete ? h('span.pf-status', 'Graduating') : h('span.pf-curve', bar(pct, false, `Bonding curve ${number(pct, 1)}%`), h('small', `${number(pct, 1)}%`)); };
      const tbody = h('tbody', created.map(t => {
        const fees = h('td.num', { 'data-label': 'Creator fees' }, h('span.muted', 'Loading…')); feeCells.set(t.address.toLowerCase(), fees);
        return h('tr.tk-row', h('td.pf-cell-token', tokenCell(t)), h('td.pf-cell-status', { 'data-label': 'Curve' }, status(t)), h('td.num.pf-cell-main', { 'data-label': 'Market cap' }, h('strong', fmtValue(pricing(t).marketCap, t))), h('td.num', { 'data-label': '24h volume' }, t.volume24h != null ? fmtValue(Number(t.volume24h), t) : '—'), h('td.num', { 'data-label': 'You hold' }, t.devHoldingPct != null ? `${number(t.devHoldingPct, 2)}%` : '—'), fees, h('td.num', { 'data-label': '24h' }, change(t)), h('td.num.pf-cell-action', h('a.btn.btn-secondary.btn-sm', { href: href(t) }, 'Open')));
      }));
      body = h('div.tk-card.pf-card', h('div.table-scroll', h('table.market-table.tk-table.pf-table',
        h('thead', h('tr', ...['Token', 'Status', 'Market cap', '24h volume', 'You hold', 'Creator fees', '24h', ''].map((label, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : '' }, label)))), tbody)),
        h('p.meta.pf-note', 'Creator fees are lifetime totals, including amounts already claimed. Claim what is owed on the Rewards page.'));
    }
  }
  // Creator fees load on every tab. A launch still being indexed answers "loading": retry it a few times, and show
  // "Indexing…" rather than a total that would leave it out.
  if (signedIn && created.length) {
    const results = new Map();
    const drawFees = () => {
      const all = [...results.values()], pending = all.length < Math.min(created.length, LOAD_LIMIT) || all.some(r => r?.status === 'loading');
      const totals = sumFees(all);
      sum.fees.value.textContent = totals.length ? totals.map(a => `${number(a.amount, a.amount < 1 ? 6 : 2)} ${a.symbol}`).join(' + ') : pending ? 'Indexing…' : '0';
      sum.fees.note.textContent = totals.length && pending ? ' so far' : '';
    };
    drawFees();
    queueMicrotask(() => each(created.slice(0, LOAD_LIMIT), 4, async t => {
      const cellEl = feeCells.get(t.address.toLowerCase());
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await ctx.api(`creator-fees?network=${encodeURIComponent(t.network ?? network)}&token=${encodeURIComponent(t.address)}`);
          if (!strip.isConnected) return;
          results.set(t.address.toLowerCase(), result);
          if (cellEl) cellEl.textContent = result.status === 'ready' ? (result.assets.filter(a => Number(a.amount) > 0).map(a => `${number(a.amount, 6)} ${a.symbol}`).join(' + ') || '0') : result.status === 'loading' ? 'Indexing…' : 'Unavailable';
          drawFees();
          if (result.status !== 'loading') return;
        } catch { if (cellEl) cellEl.textContent = 'Unavailable'; results.set(t.address.toLowerCase(), null); drawFees(); return; }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }));
  } else sum.fees.value.textContent = signedIn ? '0' : '—';

  // Positions load on every tab, so the P&L totals are right wherever the page opens.
  if (signedIn && rows.length) queueMicrotask(() => each(rows.slice(0, LOAD_LIMIT), 4, async row => {
    const t = row.token, cells = posCells.get(t.address.toLowerCase());
    try {
      const data = await ctx.api(`terminal?network=${encodeURIComponent(t.network ?? network)}&token=${t.address}${author ? `&author=${encodeURIComponent(author)}` : ''}`);
      if (!strip.isConnected) return;
      const p = data.position;
      rows = withPosition(rows, t.address, p);
      drawSummary();
      if (!cells) return;
      cells.entry.textContent = p?.entryMarketCapQuote ? fmtValue(Number(p.entryMarketCapQuote), t) : '—';
      if (p?.basisKnown) {
        const u = Number(p.unrealizedQuote), dir = u > 0 ? 'up' : u < 0 ? 'down' : '';
        cells.pnl.replaceChildren(h(`span${dir ? '.' + dir : ''}`, row.rate !== null ? signed(u * row.rate) : `${u > 0 ? '+' : ''}${number(u, 6)} ${t.quoteSymbol ?? ''}`), h('small.pf-pct', ` ${Number(p.unrealizedPercent) > 0 ? '+' : ''}${number(p.unrealizedPercent, 2)}%`));
      } else cells.pnl.replaceChildren(h('span.muted', { title: p?.reason ?? 'Position data unavailable.' }, 'Unknown cost'));
    } catch { cells?.pnl.replaceChildren(h('span.muted', 'Unavailable')); }
  }));

  const where = mode === 'local' ? ctx.envLabel() : !signedIn ? 'Not connected' : `${short(author)} · ${ctx.envLabel()}`;
  return h('div.pf.pf-v2',
    h('header.pf-top',
      h('div.pf-title', h('h1', 'Portfolio'), h('span.tk-chain', { title: ctx.envLabel() }, chainIcon(network), h('span', where))),
      h('div.pf-top-actions', h('a.tk-pill', { href: '#/rewards' }, icon('gift', 'icon-sm'), 'Rewards'), h('a.btn-accent.btn-accent-sm', { href: '#/launch' }, icon('plus', 'icon-sm'), 'New token'))),
    strip,
    h('div.pf-tabs', { role: 'tablist', 'aria-label': 'Portfolio sections' }, TABS.map(([key, label]) => h('a', { role: 'tab', href: `#/portfolio?tab=${key}`, 'aria-selected': String(key === tab) }, label, h('span.tk-count', String(counts[key]))))),
    body,
    mode === 'testnet' ? h('p.meta.pf-scope', `Showing ${ctx.wallet.net.name}. Switch the network to see tokens on other chains.`) : null);
}
