// Home / Explore: the Trending strip and the Explore list with sort tabs, pair and chain
// chips, the Live feed column, pagination and URL state. One persistent controller per visit: refreshes
// update cards in place (keyed by network and address), so rolling numbers and flashes show real changes.
// Every figure comes from the indexers; a module with nothing to show is hidden, never filled in.
import { h, icon, short, number, avatar, pricing, fmtMarketCap, fmtValue, progressOf, toast } from './ui.mjs';
import { odometer, setOdometer, changeDirection } from './odometer.mjs';
import { assetIcon, chainIcon } from './chain-ui.mjs';
import { nowSeconds } from './clock.mjs';
import { devLabel } from '/curve-model.mjs';
import { PAIR_LIMITS } from '/pairs.mjs';
import { partnerChip } from './partner-labels.mjs';
import { exploreModel, pageOf, pageButtons, trendingTokens, feedRows, exploreStateFromHash, exploreHash, PER_PAGE, PER_PAGE_WIDE } from './discovery.mjs';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const keyOf = t => `${t.network ?? 'local'}:${String(t.address).toLowerCase()}`;

/* ---------- Relative times ---------- */
function ago(seconds, { long = false } = {}) {
  const s = Math.max(0, Math.round(seconds));
  if (long) {
    const unit = s < 60 ? ['second', s] : s < 3600 ? ['minute', Math.floor(s / 60)] : s < 86400 ? ['hour', Math.floor(s / 3600)] : ['day', Math.floor(s / 86400)];
    return unit[1] === 0 ? 'just now' : `${unit[1]} ${unit[0]}${unit[1] === 1 ? '' : 's'} ago`;
  }
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const TIME_FORMATS = {
  age: at => ago(nowSeconds() - at),
  'age-long': at => ago(nowSeconds() - at, { long: true }),
  bought: at => `Bought ${ago(nowSeconds() - at)}`,
};
/** <time> that keeps itself current (see tickTimes). `at` is in seconds. */
function timeNode(spec, at, format) {
  if (!at) return null;
  return h(spec, { dateTime: new Date(at * 1000).toISOString(), 'data-at': String(at), 'data-format': format, title: new Date(at * 1000).toLocaleString() }, TIME_FORMATS[format](at));
}
function tickTimes(root) { for (const node of root.querySelectorAll('time[data-at]')) { const text = TIME_FORMATS[node.dataset.format]?.(Number(node.dataset.at)); if (text && node.textContent !== text) node.textContent = text; } }

/* ---------- Small pieces ---------- */
function pairIcon(token, nativeSymbol) {
  const pair = token.pair ?? 'native';
  if (pair === 'native') return assetIcon(token.quoteSymbol ?? nativeSymbol);
  if (pair === 'usdc') return assetIcon('USDC');
  if (pair === 'xstock' && token.quoteSymbol) return assetIcon(token.quoteSymbol, true, { provider: token.stock?.provider ?? null });
  return icon(pair === 'xstock' ? 'chart-candlestick' : 'layers', 'icon-sm');
}
function pairStack(token, nativeSymbol, networkName) {
  return h('span.pair-stack', { title: `${token.quoteSymbol ?? nativeSymbol} pair on ${networkName}` }, pairIcon(token, nativeSymbol), chainIcon(token.network ?? 'local'));
}
function changePill(token) {
  const change = token.priceChange24h;
  if (!change || !Number.isFinite(change.percent)) return null;
  const up = change.percent >= 0;
  return h(`span.pct-pill.${up ? 'pct-up' : 'pct-down'}`, { title: `${change.basis ?? '24h change'}` }, `${up ? '+' : ''}${number(change.percent, 2)}%`);
}
function curveLine(token) {
  if (token.graduated) return h('span.curve-done', icon('circle-check', 'icon-xs'), 'Graduated');
  const pct = progressOf(token);
  const fill = h('span', { style: `width:${pct}%` });
  return h('span.curve-line', { 'data-state': token.complete ? 'done' : 'open' },
    h('span.curve-track', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Bonding curve progress' }, fill),
    h('span.curve-pct', token.complete ? 'Migrating' : `${number(pct, pct < 10 ? 1 : 0)}%`));
}
function updateCurve(node, token) {
  const bar = node.querySelector('.curve-track'), label = node.querySelector('.curve-pct');
  if (!bar || token.graduated) return;
  const pct = progressOf(token);
  bar.firstElementChild.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  label.textContent = token.complete ? 'Migrating' : `${number(pct, pct < 10 ? 1 : 0)}%`;
}
/** Figures shown on cards, with the raw numbers used to decide which way a change rolls. */
function figures(token) {
  const cap = pricing(token).marketCap, volume = token.volume24h;
  return { cap, capText: cap > 0 ? fmtMarketCap(token) : '—', volume: volume == null ? null : Number(volume), volumeText: volume == null ? '—' : fmtValue(Number(volume), token) };
}
function devBadge(token) {
  if (token.devBoughtPct == null) return null;
  const pct = Number(token.devHoldingPct ?? token.devBoughtPct);
  return h('span.dev-badge', { 'data-level': pct > 10 ? 'high' : 'ok', title: devLabel(token.devBoughtPct, token.devHoldingPct) }, `Dev ${number(pct, 1)}%`);
}
/** Partner tokens: the share of trading fees that buys back and burns the token, fixed at launch. */
function burnBadge(token) {
  const chip = partnerChip(token);
  return chip ? h('span.burn-badge', { 'data-tier': chip.tier.toLowerCase(), title: chip.title, 'aria-label': chip.title }, icon('flame', 'icon-xs'), chip.text) : null;
}
/** A scroller with prev/next buttons and edge fades that only show while there is more to scroll. */
function scroller(track, prev, next) {
  const sync = () => {
    const max = track.scrollWidth - track.clientWidth - 2;
    prev.disabled = track.scrollLeft <= 2; next.disabled = track.scrollLeft >= max;
    track.parentElement?.toggleAttribute('data-fade-start', track.scrollLeft > 2);
    track.parentElement?.toggleAttribute('data-fade-end', track.scrollLeft < max);
  };
  const go = way => track.scrollBy({ left: way * Math.max(160, track.clientWidth * 0.9), behavior: reducedMotion() ? 'auto' : 'smooth' });
  prev.addEventListener('click', () => go(-1)); next.addEventListener('click', () => go(1));
  track.addEventListener('scroll', sync, { passive: true });
  return sync;
}

/* ---------- Cards ---------- */
// Values roll only between two figures in the same unit (dollars, or the same pair asset).
const sameUnit = (a, b) => a.startsWith('$') === b.startsWith('$');
function staticSignature(t) { return JSON.stringify([t.name, t.symbol, t.metadata?.image ?? t.image ?? '', t.network, t.pair, t.quoteSymbol, !!t.graduated, !!t.complete, t.devBoughtPct, t.devHoldingPct, t.created, t.creator, t.buybackBps, t.burned]); }

function listCard(token, ctx) {
  const f = figures(token), href = ctx.tokenHref(token), name = token.metadata?.name ?? token.name, symbol = token.metadata?.symbol ?? token.symbol;
  const isNew = token.created && nowSeconds() - token.created / 1000 < 86400;
  const cap = odometer(f.capText, 'lc-cap'), volume = odometer(f.volumeText, 'lc-volume');
  const bought = h('span.lc-bought', icon('clock', 'icon-xs'), token.lastBuyAt ? timeNode('time', token.lastBuyAt, 'bought') : h('span', 'No buys yet'));
  const card = h('article.list-card', { 'data-key': keyOf(token) },
    h('div.lc-media', avatar(token, 'lc-avatar'), isNew ? h('span.new-chip', 'New') : null),
    h('div.lc-body',
      h('div.lc-top', h('h3.lc-name', h('a.lc-link', { href }, name)), icon('arrow-up-right', 'icon-sm lc-go')),
      h('div.lc-meta', h('span.lc-ticker', `$${symbol}`), h('span.sep', { 'aria-hidden': 'true' }, '·'), pairStack(token, ctx.nativeSymbol(token), ctx.networkName(token)), token.created ? [h('span.sep', { 'aria-hidden': 'true' }, '·'), timeNode('time.lc-age', Math.floor(token.created / 1000), 'age')] : null, devBadge(token), burnBadge(token)),
      h('div.lc-figures',
        h('div', h('span.lc-label', 'Market cap'), cap),
        h('div.lc-right', h('span.lc-label', '24h volume'), volume)),
      curveLine(token)),
    h('div.lc-foot', bought, h('button.lc-copy', { type: 'button', 'aria-label': `Copy token address ${token.address}`, on: { click: () => copy(token.address) } }, h('span.mono', short(token.address)), icon('copy', 'icon-xs'))));
  card._sig = staticSignature(token);
  card._raw = f;
  card._update = next => {
    const g = figures(next), unit = sameUnit(g.capText, card._raw.capText);
    setOdometer(cap, g.capText, unit ? changeDirection(card._raw.cap, g.cap) : 0);
    setOdometer(volume, g.volumeText, unit && g.volume !== null && card._raw.volume !== null ? changeDirection(card._raw.volume, g.volume) : 0);
    updateCurve(card, next);
    const time = card.querySelector('.lc-bought time');
    if (next.lastBuyAt && Number(time?.dataset.at) !== next.lastBuyAt) bought.replaceChildren(icon('clock', 'icon-xs'), timeNode('time', next.lastBuyAt, 'bought'));
    card._raw = g;
  };
  return card;
}

function trendCard(token, rank, ctx) {
  const f = figures(token), href = ctx.tokenHref(token), name = token.metadata?.name ?? token.name, symbol = token.metadata?.symbol ?? token.symbol;
  const cap = odometer(f.capText, 'tc-value'), volume = odometer(f.volumeText, 'tc-value');
  const rankChip = h('span.rank-chip', `#${rank}`), pill = h('span.tc-pill', changePill(token));
  const card = h('li.trend-item', { 'data-key': keyOf(token) }, h('article.trend-card',
    // The whole card opens the token; the name link is the one keyboard and screen reader users get.
    h('a.card-cover', { href, tabIndex: -1, 'aria-hidden': 'true' }),
    h('div.tc-media', avatar(token, 'tc-image'), rankChip, pill,
      h('div.tc-band', h('h3.tc-name', h('a.tc-link', { href }, name)), h('span.tc-ticker', `$${symbol}`, pairStack(token, ctx.nativeSymbol(token), ctx.networkName(token))), curveLine(token))),
    h('div.tc-stats', h('div', h('span.label-xs', 'Market cap'), cap), h('div', h('span.label-xs', '24h volume'), volume)),
    h('div.tc-foot', h('span.mono.tc-address', short(token.address)), token.created ? timeNode('time.mono.tc-age', Math.floor(token.created / 1000), 'age-long') : null)));
  card._sig = staticSignature(token);
  card._raw = f;
  card._update = (next, nextRank) => {
    const g = figures(next), unit = sameUnit(g.capText, card._raw.capText);
    setOdometer(cap, g.capText, unit ? changeDirection(card._raw.cap, g.cap) : 0);
    setOdometer(volume, g.volumeText, unit && g.volume !== null && card._raw.volume !== null ? changeDirection(card._raw.volume, g.volume) : 0);
    rankChip.textContent = `#${nextRank}`;
    pill.replaceChildren(changePill(next) ?? '');
    updateCurve(card, next);
    card._raw = g;
  };
  return card;
}

/** Re-uses cards whose identity is unchanged, so their numbers roll instead of re-rendering. */
function reconcile(container, items, cache, build, update) {
  const seen = new Set(), nodes = [];
  items.forEach((token, i) => {
    const key = keyOf(token); seen.add(key);
    let node = cache.get(key);
    if (node && node._sig !== staticSignature(token)) node = null;
    if (node) update(node, token, i);
    else {
      node = build(token, i); cache.set(key, node);
      // Enter once: drop the class when its own animation ends, so moving the card later does not replay it.
      node.classList.add('card-enter'); node.style.setProperty('--i', String(Math.min(i, 11)));
      const done = event => { if (event.target === node) { node.classList.remove('card-enter'); node.removeEventListener('animationend', done); } };
      node.addEventListener('animationend', done);
    }
    nodes.push(node);
  });
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  // Move only what is out of place so focus and running animations survive a refresh.
  nodes.forEach((node, i) => { if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null); });
  while (container.children.length > nodes.length) container.lastElementChild.remove();
}
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('Address copied.', { kind: 'success' }); } catch { toast(value); } }

/* ---------- Controller ---------- */
/**
 * source: {
 *   tokens(): listed tokens (with 24h activity), networks(): chains for the chain chips,
 *   mode(): 'local' | 'testnet', errors(): networks that failed to load, tokenHref(token),
 *   nativeSymbol(token), networkName(token), prices(): [{symbol, usd, source, updatedAt}],
 *   onQuery(text): keeps the top bar search in step
 * }
 */
export function createExplore(source) {
  const state = { ...exploreStateFromHash(location.hash), feed: store.get('elpida:feed') !== 'off', trades: [] };
  const listCache = new Map(), trendCache = new Map();
  const ctx = { tokenHref: source.tokenHref, nativeSymbol: source.nativeSymbol, networkName: source.networkName };

  /* Trending */
  const trendTrack = h('ol.trend-track', { 'aria-label': 'Trending tokens' });
  const trendPrev = h('button.round-button', { type: 'button', 'aria-label': 'Previous trending tokens' }, icon('chevron-left', 'icon-sm'));
  const trendNext = h('button.round-button', { type: 'button', 'aria-label': 'Next trending tokens' }, icon('chevron-right', 'icon-sm'));
  const trending = h('section.home-section.trending', { 'aria-labelledby': 'trending-title', hidden: true },
    h('div.section-head', h('div.section-title', h('h2#trending-title', 'Trending'), h('span.section-sub', 'By 24h volume')),
      h('div.section-actions', h('button.btn.btn-secondary.btn-sm.view-all', { type: 'button', on: { click: () => { set({ tab: 'trending', page: 1 }); jumpToList(); } } }, 'View all', icon('arrow-right', 'icon-sm accent-icon')), trendPrev, trendNext)),
    h('div.scroll-fade', trendTrack));
  const syncTrend = scroller(trendTrack, trendPrev, trendNext);

  /* Explore list */
  const launched = h('span.launched');
  const tabs = h('div.sort-tabs', { role: 'group', 'aria-label': 'Sort tokens' },
    [['trending', 'flame', 'Trending'], ['marketcap', 'chart-column', 'Market cap'], ['new', 'sprout', 'New pairs'], ['lastsale', 'clock', 'Last sale'], ['graduating', 'mountain', 'Graduating']].map(([key, glyph, label]) =>
      h('button.sort-tab', { type: 'button', 'data-tab': key, 'aria-pressed': 'false', on: { click: () => set({ tab: key, page: 1 }) } }, icon(glyph, 'icon-sm'), label)));
  const filter = h('input', { type: 'search', placeholder: 'Filter by name, ticker or address', 'aria-label': 'Filter tokens by name, ticker or address', autocomplete: 'off', value: state.query, on: { input: e => { set({ query: e.target.value, page: 1 }, { fromFilter: true }); } } });
  filter.spellcheck = false;
  const feedToggle = h('button.feed-toggle', { type: 'button', 'aria-pressed': String(state.feed), 'aria-controls': 'live-feed', on: { click: () => setFeed(!state.feed) } }, icon('radio', 'icon-sm'), 'Live feed');
  const pairChips = h('div.chip-scroll', { role: 'group', 'aria-label': 'Paired with' });
  const chainChips = h('div.chip-scroll', { role: 'group', 'aria-label': 'Chain' });
  const pairRow = h('div.chip-row', h('span.chip-row-label', icon('sliders-horizontal', 'icon-xs'), 'Paired with'), pairChips);
  const chainRow = h('div.chip-row', { hidden: true }, h('span.chip-row-label', icon('globe', 'icon-xs'), 'Chain'), chainChips);
  const errors = h('p.small.error-text.explore-errors', { role: 'status' });
  const meta = h('div.list-meta', { 'aria-live': 'polite' });
  const grid = h('div.list-grid');
  const empty = h('div.list-empty');
  const pager = h('nav.pagination', { 'aria-label': 'Token pages' });
  const prices = h('div.price-note');

  /* Live feed */
  const feedList = h('ol.feed-list', { 'aria-label': 'Latest buys' });
  // "Live" shows only while buys are actually coming in.
  const livePill = h('span.live-pill', { hidden: true }, h('span.live-dot'), 'Live');
  const feedEmpty = h('p.feed-empty', 'No buys yet. New buys show up here within a minute.');
  const feed = h('aside.live-feed#live-feed', { 'aria-labelledby': 'live-feed-title', hidden: !state.feed },
    h('div.feed-head', h('h2#live-feed-title', 'Live feed'), livePill, h('button.round-button.feed-close', { type: 'button', 'aria-label': 'Hide live feed', on: { click: () => setFeed(false) } }, icon('x', 'icon-sm'))),
    h('p.feed-sub', icon('zap', 'icon-xs'), 'Latest buys'),
    feedList, feedEmpty,
    h('button.feed-more', { type: 'button', on: { click: () => { set({ tab: 'lastsale', page: 1 }); jumpToList(); } } }, 'Explore recent buys', icon('arrow-right', 'icon-sm accent-icon')));

  const listSection = h('section.home-section.explore-section#explore', { 'aria-labelledby': 'explore-title' },
    h('div.explore-head', h('h2#explore-title', 'Explore'), launched),
    h('div.explore-controls', tabs, h('div.explore-tools', h('label.filter-field', icon('search', 'icon-sm'), filter), feedToggle)),
    pairRow, chainRow, errors,
    // The body is a size container: the feed drops below the list when the column gets narrow.
    h('div.explore-body', { 'data-feed': String(state.feed) }, h('div.explore-layout',
      h('div.explore-list', meta, grid, empty, pager),
      feed)),
    prices);
  const root = h('div.explore', h('h1.visually-hidden', 'Explore tokens'), trending, listSection);

  function jumpToList() { listSection.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
  function writeUrl() { const next = exploreHash(state); if (location.hash !== next && (location.hash || '#/') !== next) history.replaceState(history.state, '', next); }
  function set(patch, { fromFilter = false } = {}) {
    Object.assign(state, patch);
    if (!fromFilter && 'query' in patch && filter.value !== state.query) filter.value = state.query;
    if ('query' in patch) source.onQuery?.(state.query);
    writeUrl(); draw();
  }
  function setFeed(open) {
    state.feed = open; store.set('elpida:feed', open ? 'on' : 'off');
    feed.hidden = !open; feedToggle.setAttribute('aria-pressed', String(open));
    listSection.querySelector('.explore-body').dataset.feed = String(open);
    if (!open && feed.contains(document.activeElement)) feedToggle.focus();
    draw(); // the page size follows the layout: 8 beside the feed, 12 across the full width
  }
  function perPage() { return state.feed ? PER_PAGE : PER_PAGE_WIDE; }

  function drawTrending(tokens) {
    const list = trendingTokens(tokens, 10);
    trending.hidden = !list.length;
    if (!list.length) { trendTrack.replaceChildren(); trendCache.clear(); return; }
    reconcile(trendTrack, list, trendCache, (t, i) => trendCard(t, i + 1, ctx), (node, t, i) => node._update(t, i + 1));
    requestAnimationFrame(syncTrend);
  }
  function drawChips(counts) {
    const nets = source.networks();
    const singleChain = state.chain !== 'all' && nets.length === 1 ? nets[0] : nets.find(n => n.key === state.chain);
    const limitFor = kind => singleChain && PAIR_LIMITS[singleChain.kind]?.[kind];
    pairChips.replaceChildren(...[['all', 'All'], ['native', 'Native'], ['usdc', 'USDC'], ['xstock', 'xStocks'], ['token', 'Tokens']].map(([key, label]) => {
      const limit = key !== 'all' && limitFor(key), count = counts.pair[key] ?? 0, active = state.pair === key;
      const glyph = key === 'all' ? icon('layers', 'icon-sm') : key === 'native' ? icon('coins', 'icon-sm') : key === 'usdc' ? assetIcon('USDC') : key === 'xstock' ? icon('chart-candlestick', 'icon-sm') : icon('layers', 'icon-sm');
      return h('button.filter-chip', { type: 'button', 'aria-pressed': String(active), disabled: !active && (!!limit || (key !== 'all' && count === 0)), title: limit || (key !== 'all' && count === 0 ? `No ${{ native: 'native-coin', usdc: 'USDC', xstock: 'xStock', token: 'token-paired' }[key]} launches here yet` : undefined), on: { click: () => set({ pair: key, page: 1 }) } },
        key === 'all' ? null : glyph, h('span', label), h('span.chip-count', number(count, 0)));
    }));
    const showChains = source.mode() === 'testnet' && nets.length > 1;
    chainRow.hidden = !showChains;
    if (!showChains) { chainChips.replaceChildren(); return; }
    chainChips.replaceChildren(...[{ key: 'all', name: 'All chains' }, ...nets].map(net => {
      const count = counts.chain[net.key] ?? 0, active = state.chain === net.key;
      return h('button.filter-chip', { type: 'button', 'aria-pressed': String(active), disabled: !active && net.key !== 'all' && count === 0, title: net.key !== 'all' && count === 0 ? `No launches on ${net.name} yet` : undefined, on: { click: () => set({ chain: net.key, page: 1 }) } },
        net.key === 'all' ? icon('globe', 'icon-sm') : chainIcon(net.key), h('span', net.name), h('span.chip-count', number(count, 0)));
    }));
  }
  function drawPager(view) {
    if (view.pages <= 1) { pager.replaceChildren(); pager.hidden = true; return; }
    pager.hidden = false;
    const go = page => () => { set({ page }); jumpToList(); };
    pager.replaceChildren(
      h('span.pager-note', `Showing ${number(view.from, 0)}–${number(view.to, 0)} of ${number(view.total, 0)} tokens`, h('small', `${perPage()} per page`)),
      h('div.pager-buttons',
        h('button.page-button', { type: 'button', 'aria-label': 'Previous page', disabled: view.page <= 1, on: { click: go(view.page - 1) } }, icon('chevron-left', 'icon-sm')),
        pageButtons(view.page, view.pages).map(p => p === '…' ? h('span.page-gap', { 'aria-hidden': 'true' }, '…') : h('button.page-button', { type: 'button', 'aria-label': `Page ${p}`, 'aria-current': p === view.page ? 'page' : undefined, on: { click: go(p) } }, String(p))),
        h('button.page-button', { type: 'button', 'aria-label': 'Next page', disabled: view.page >= view.pages, on: { click: go(view.page + 1) } }, icon('chevron-right', 'icon-sm'))));
  }
  function drawFeed(tokens) {
    const rows = feedRows(state.trades, tokens, 20);
    feedEmpty.hidden = rows.length > 0; livePill.hidden = !rows.length;
    const before = new Set([...feedList.children].map(li => li.dataset.key));
    const firstDraw = !feedList.dataset.drawn;
    feedList.replaceChildren(...rows.map(({ trade, token }) => {
      const key = `${keyOf(token)}:${trade.timestamp}`, f = figures(token);
      const li = h('li.feed-row', { 'data-key': key, class: !firstDraw && !before.has(key) ? 'arrive' : undefined },
        h('a.feed-link', { href: source.tokenHref(token) },
          avatar(token, 'feed-avatar'),
          h('span.feed-main', h('strong', token.metadata?.name ?? token.name), h('small', `$${token.metadata?.symbol ?? token.symbol} · ${token.quoteSymbol ?? source.nativeSymbol(token)}`)),
          h('span.feed-side', timeNode('time.feed-when', trade.timestamp, 'bought'), f.cap > 0 ? h('small', `${f.capText} MC`) : null)));
      return li;
    }));
    feedList.dataset.drawn = '1';
  }
  function drawPrices() {
    const list = source.prices();
    if (!list.length) { prices.replaceChildren(); return; }
    prices.replaceChildren(h('details',
      h('summary', h('span', 'Dollar values use'), list.map(p => h('span.price-ref', assetIcon(p.symbol), h('strong', p.symbol), p.usd ? `$${number(p.usd, 2)}` : 'unavailable')), h('span.price-more', 'Sources')),
      h('ul', list.map(p => h('li', `${p.symbol}: ${p.source ?? 'Unavailable'}${p.updatedAt ? ` · updated ${new Date(p.updatedAt * 1000).toLocaleString()}` : ''}.`)),
        h('li', 'USDC pairs are valued at $1 (assumed parity). Other pairs stay in their own asset. Display reference only; launch fees are verified separately by the contracts.'))));
  }

  function draw() {
    const tokens = source.tokens() ?? [];
    // A chain chip from a shared link that this environment does not list falls back to all chains.
    if (state.chain !== 'all' && !source.networks().some(n => n.key === state.chain)) state.chain = 'all';
    launched.textContent = `· ${number(tokens.length, 0)} launched`;
    tabs.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === state.tab; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-active', on); });
    const model = exploreModel(tokens, state);
    const view = { ...pageOf(model.items, state.page, perPage()), total: model.items.length };
    if (view.page !== state.page) { state.page = view.page; writeUrl(); }
    drawTrending(tokens);
    drawChips(model.counts);
    const failed = source.errors();
    errors.textContent = failed.length ? `Some networks could not load: ${failed.join(', ')}. Refresh to retry.` : '';
    errors.hidden = !failed.length;
    meta.hidden = !view.total;
    meta.replaceChildren(h('span', `Showing ${number(view.from, 0)}–${number(view.to, 0)} of ${number(view.total, 0)}`), ...(view.pages > 1 ? [h('span', `Page ${view.page} of ${view.pages}`)] : []));
    reconcile(grid, view.items, listCache, t => listCard(t, ctx), (node, t) => node._update(t));
    const filtered = state.query.trim() || state.pair !== 'all' || state.chain !== 'all' || state.tab === 'graduating';
    empty.replaceChildren(view.total ? '' : tokens.length && filtered
      ? h('div.empty.empty-compact', h('h3', 'No tokens match'), h('p', state.tab === 'graduating' && !state.query.trim() && state.pair === 'all' && state.chain === 'all' ? 'Every listed token has graduated.' : 'Try another name, ticker or address, or clear the filters.'),
        h('button.btn.btn-secondary', { type: 'button', on: { click: () => set({ query: '', pair: 'all', chain: 'all', tab: state.tab === 'graduating' ? 'trending' : state.tab, page: 1 }) } }, 'Clear filters'))
      : h('div.empty', h('img.brand-dark', { src: '/assets/brand/elpida-mark-dark.svg?v=mark-20261019', alt: '' }), h('img.brand-light', { src: '/assets/brand/elpida-mark.svg?v=mark-20261019', alt: '' }), h('h3', 'No launches yet'), h('p', source.mode() === 'local' ? 'Tokens you launch in the simulation appear here.' : 'Tokens launched on Elpida networks appear here as soon as they are indexed.'),
        h('a.btn-accent', { href: '#/launch' }, icon('plus', 'icon-sm'), 'Create a token')));
    empty.hidden = !!view.total;
    drawPager(view);
    drawFeed(tokens);
    drawPrices();
  }

  const timer = setInterval(() => { if (document.visibilityState === 'visible') tickTimes(root); }, 15000);
  const onResize = () => { syncTrend(); syncCreators(); };
  addEventListener('resize', onResize, { passive: true });
  draw();
  return {
    root,
    /** New data from a refresh: cards update in place. */
    update() { draw(); },
    /** Recent buys for the Live feed (newest first, the /recent-trades shape). */
    setTrades(trades) { state.trades = Array.isArray(trades) ? trades : []; drawFeed(source.tokens() ?? []); },
    /** A query typed in the top bar search. */
    setQuery(query,{reveal=false}={}) { if(query!==state.query||reveal){Object.assign(state,{query,page:1,...(reveal?{chain:'all',pair:'all',tab:'trending'}:{})});if(filter.value!==query)filter.value=query;writeUrl();draw();}if(reveal)jumpToList(); },
    revealSearch(){jumpToList();},
    /** The hash changed (a pasted or shared link): adopt its view state. */
    readUrl() { const next = exploreStateFromHash(location.hash); const changed = ['tab', 'pair', 'chain', 'query', 'page'].some(k => next[k] !== state[k]); if (!changed) return; Object.assign(state, next); if (filter.value !== state.query) filter.value = state.query; source.onQuery?.(state.query); draw(); },
    get query() { return state.query; },
    dispose() { clearInterval(timer); removeEventListener('resize', onResize); },
  };
}

/** Placeholder while the first data loads: the Explore frame with shimmering cards. */
export function exploreSkeleton() {
  return h('div.explore', { 'aria-busy': 'true' }, h('h1.visually-hidden', 'Explore tokens'),
    h('section.home-section.explore-section', h('div.explore-head', h('h2', 'Explore'), h('span.launched', 'Loading…')),
      h('div.list-grid', Array.from({ length: 6 }, () => h('div.skeleton.list-skeleton', { 'aria-hidden': 'true' })))));
}
