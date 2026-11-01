import { h, icon, short, number, compact, avatar, pricing, fmtMarketCap, fmtValue, progressOf, usdRate, bar, storage } from './ui.mjs';
import { chainIcon } from './chain-ui.mjs';
import { holdingRows, withPosition, summarize, sumFees, crossChainTokens, networkCounts } from './portfolio-model.mjs';

// Portfolio: one summary bar, then Holdings (value, entry and P&L per token), Launched (curve, market cap and
// lifetime creator fees per launch) and Drafts. Every figure comes from the indexed state, `/api/terminal`
// (positions) or `/api/creator-fees`; anything not yet loaded shows a dash, never an estimate.

const TABS = [['holdings', 'Holdings'], ['launched', 'Launched'], ['drafts', 'Drafts']];
const LOAD_LIMIT = 30;
const href = t => `#/token/${t.address}${t.network ? '?network=' + encodeURIComponent(t.network) : ''}`;
const usd = v => { if (v === null || v === undefined || !Number.isFinite(v)) return '—'; const a = Math.abs(v); const sign = v < 0 ? '-' : ''; return a > 0 && a < 0.01 ? `${sign}<$0.01` : `${sign}$${a < 1000 ? number(a, 2) : compact(a)}`; };
const signed = v => v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${usd(v)}`;

// Short-lived answers, so a background refresh of the page does not refetch every position and fee total.
const cache = new Map();
async function cached(key, ttl, load, keep = () => true) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  if (keep(value)) { cache.set(key, { at: Date.now(), value }); if (cache.size > 400) cache.delete(cache.keys().next().value); }
  return value;
}
const BALANCES_TTL = 30000, POSITION_TTL = 20000, FEES_TTL = 30000;

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
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  // EVM wallets on public testnets see every EVM network: indexed balances joined to Explore's token list. Solana
  // and the local simulation keep the selected network only.
  const crossChain = mode === 'testnet' && ctx.wallet !== ctx.solWallet && /^0x[0-9a-fA-F]{40}$/.test(author ?? '');
  const everyToken = crossChain ? (ctx.allTokens?.() ?? []) : [];
  const balancesKey = crossChain ? `balances:${author.toLowerCase()}` : null, balancesHit = balancesKey ? cache.get(balancesKey) : null;
  const live = (state?.tokens ?? []).map(t => ({ ...t, network: t.network ?? network }));
  const tokens = crossChain && balancesHit && everyToken.length ? crossChainTokens(balancesHit.value.balances, everyToken, { network, tokens: live }) : live;
  const ownerKey = String(state.wallet ?? author ?? '').toLowerCase();
  const allCreated = signedIn && ownerKey ? (crossChain && everyToken.length ? everyToken : live).filter(t => t.creator?.toLowerCase() === ownerKey) : [];
  const allRows = signedIn ? holdingRows(tokens, { price: t => pricing(t).price, rate: usdRate }) : [];
  const nets = networkCounts([...allRows.map(r => r.token), ...allCreated]);
  const chosenNet = nets.some(n => n.network === params.get('net')) ? params.get('net') : 'all';
  const onNet = t => chosenNet === 'all' || t.network === chosenNet;
  let rows = allRows.filter(r => onNet(r.token));
  const created = allCreated.filter(onNet);
  if (crossChain && (!balancesHit || Date.now() - balancesHit.at >= BALANCES_TTL)) {
    // Fetch once, then draw again from the cache. A failure keeps the selected network's own figures.
    queueMicrotask(async () => {
      try { await cached(balancesKey, BALANCES_TTL, () => ctx.api(`public/balances?owner=${encodeURIComponent(author)}`)); if (document.querySelector('.pf-v2')) rerender(); } catch {}
    });
  }
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
        posCells.set(`${t.network}:${t.address.toLowerCase()}`, { entry, pnl, row });
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
        const fees = h('td.num', { 'data-label': 'Creator fees' }, h('span.muted', 'Loading…')); feeCells.set(`${t.network}:${t.address.toLowerCase()}`, fees);
        return h('tr.tk-row', h('td.pf-cell-token', tokenCell(t)), h('td.pf-cell-status', { 'data-label': 'Curve' }, status(t)), h('td.num.pf-cell-main', { 'data-label': 'Market cap' }, h('strong', fmtMarketCap(t))), h('td.num', { 'data-label': '24h volume' }, t.volume24h != null ? fmtValue(Number(t.volume24h), t) : '—'), h('td.num', { 'data-label': 'You hold' }, t.devHoldingPct != null ? `${number(t.devHoldingPct, 2)}%` : '—'), fees, h('td.num', { 'data-label': '24h' }, change(t)), h('td.num.pf-cell-action', h('a.btn.btn-secondary.btn-sm', { href: href(t) }, 'Open')));
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
      const cellEl = feeCells.get(`${t.network}:${t.address.toLowerCase()}`);
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await cached(`fees:${t.network}:${t.address.toLowerCase()}`, FEES_TTL, () => ctx.api(`creator-fees?network=${encodeURIComponent(t.network ?? network)}&token=${encodeURIComponent(t.address)}`), r => r?.status === 'ready');
          if (!strip.isConnected) return;
          results.set(`${t.network}:${t.address.toLowerCase()}`, result);
          if (cellEl) cellEl.textContent = result.status === 'ready' ? (result.assets.filter(a => Number(a.amount) > 0).map(a => `${number(a.amount, 6)} ${a.symbol}`).join(' + ') || '0') : result.status === 'loading' ? 'Indexing…' : 'Unavailable';
          drawFees();
          if (result.status !== 'loading') return;
        } catch { if (cellEl) cellEl.textContent = 'Unavailable'; results.set(`${t.network}:${t.address.toLowerCase()}`, null); drawFees(); return; }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }));
  } else sum.fees.value.textContent = signedIn ? '0' : '—';

  // Positions load on every tab, so the P&L totals are right wherever the page opens.
  if (signedIn && rows.length) queueMicrotask(() => each(rows.slice(0, LOAD_LIMIT), 4, async row => {
    const t = row.token, cells = posCells.get(`${t.network}:${t.address.toLowerCase()}`);
    try {
      const data = await cached(`position:${t.network}:${t.address.toLowerCase()}:${String(author).toLowerCase()}`, POSITION_TTL, () => ctx.api(`terminal?network=${encodeURIComponent(t.network ?? network)}&token=${t.address}${author ? `&author=${encodeURIComponent(author)}` : ''}`));
      if (!strip.isConnected) return;
      const p = data.position;
      rows = withPosition(rows, t.address, p, t.network);
      drawSummary();
      if (!cells) return;
      cells.entry.textContent = p?.entryMarketCapQuote ? fmtValue(Number(p.entryMarketCapQuote), t) : '—';
      if (p?.basisKnown) {
        const u = Number(p.unrealizedQuote), dir = u > 0 ? 'up' : u < 0 ? 'down' : '';
        cells.pnl.replaceChildren(h(`span${dir ? '.' + dir : ''}`, row.rate !== null ? signed(u * row.rate) : `${u > 0 ? '+' : ''}${number(u, 6)} ${t.quoteSymbol ?? ''}`), h('small.pf-pct', ` ${Number(p.unrealizedPercent) > 0 ? '+' : ''}${number(p.unrealizedPercent, 2)}%`));
      } else cells.pnl.replaceChildren(h('span.muted', { title: p?.reason ?? 'Position data unavailable.' }, 'Unknown cost'));
    } catch { cells?.pnl.replaceChildren(h('span.muted', 'Unavailable')); }
  }));

  const netName = key => ctx.networkByKey?.(key)?.name ?? key;
  const where = mode === 'local' ? ctx.envLabel() : !signedIn ? 'Not connected' : crossChain ? `${short(author)} · every EVM testnet` : `${short(author)} · ${ctx.envLabel()}`;
  const tabHref = (key, net) => `#/portfolio?tab=${key}${net && net !== 'all' ? `&net=${encodeURIComponent(net)}` : ''}`;
  const chips = nets.length > 1 ? h('div.pf-nets', { role: 'group', 'aria-label': 'Filter by network' },
    h('a.pf-net', { href: tabHref(tab, 'all'), 'aria-current': chosenNet === 'all' ? 'true' : null }, 'All networks', h('span.tk-count', String(nets.reduce((n, x) => n + x.count, 0)))),
    ...nets.map(n => h('a.pf-net', { href: tabHref(tab, n.network), 'aria-current': chosenNet === n.network ? 'true' : null }, chainIcon(n.network), netName(n.network), h('span.tk-count', String(n.count))))) : null;
  const balancesStatus = crossChain && balancesHit ? balancesHit.value.networks ?? [] : [];
  const behind = balancesStatus.filter(n => !n.fresh).map(n => netName(n.network));
  const scope = mode !== 'testnet' ? null : crossChain
    ? (balancesHit ? `Indexed balances on ${balancesStatus.length} EVM testnets${behind.length ? `; ${behind.join(', ')} ${behind.length === 1 ? 'is' : 'are'} catching up` : ''}. ${ctx.wallet.net.name} reads your wallet directly. Solana holdings show when a Solana wallet is connected.` : `Loading balances on every EVM testnet. Showing ${ctx.wallet.net.name} meanwhile.`)
    : `Showing ${ctx.wallet.net.name}. Switch the network to see tokens on other chains.`;
  return h('div.pf.pf-v2',
    h('header.pf-top',
      h('div.pf-title', h('h1', 'Portfolio'), h('span.tk-chain', { title: ctx.envLabel() }, crossChain ? icon('layers', 'icon-sm') : chainIcon(network), h('span', where))),
      h('div.pf-top-actions', h('a.tk-pill', { href: '#/rewards' }, icon('gift', 'icon-sm'), 'Rewards'), h('a.btn-accent.btn-accent-sm', { href: '#/launch' }, icon('plus', 'icon-sm'), 'New token'))),
    strip,
    h('div.pf-bar', h('div.pf-tabs', { role: 'tablist', 'aria-label': 'Portfolio sections' }, TABS.map(([key, label]) => h('a', { role: 'tab', href: tabHref(key, chosenNet), 'aria-selected': String(key === tab) }, label, h('span.tk-count', String(counts[key]))))), tab === 'drafts' ? null : chips),
    body,
    scope ? h('p.meta.pf-scope', scope) : null);
}
