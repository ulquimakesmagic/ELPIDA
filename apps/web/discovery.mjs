import { nowSeconds } from './clock.mjs';
export function freshUsd(token,now=nowSeconds()){const p=token.usdReference;return p?.status==='fresh'&&Number.isFinite(p.usd)&&p.usd>0&&now-p.updatedAt<=(p.maxAge??180)?p.usd:null;}
export function discoveryTokens(tokens,{query='',category='all'}={},now=nowSeconds()){
  const items=tokens.filter(t=>`${t.name} ${t.symbol}`.toLowerCase().includes(query.trim().toLowerCase())).filter(t=>category==='migrating'?t.complete&&!t.graduated:category==='graduated'?t.graduated:true);
  const identity=t=>`${t.network??'local'}:${t.address}`;
  return items.sort((a,b)=>{
    if(category==='new')return (b.created??0)-(a.created??0)||identity(a).localeCompare(identity(b));
    const rateA=freshUsd(a,now),rateB=freshUsd(b,now);
    if(rateA===null||rateB===null){if(rateA!==rateB)return rateA===null?1:-1;}
    const cap=t=>Number(t.spotPrice??0)*Number(t.supply??0);
    return cap(b)*(rateB??0)-cap(a)*(rateA??0)||identity(a).localeCompare(identity(b));
  });
}
export function indexedChange(db,token,now=Math.floor(Date.now()/1000)){
  // Compare executions in the quote asset, not current USD FX or an invented launch price.
  const column=db.prepare('PRAGMA table_info(trades)').all().some(c=>c.name==='mint')?'mint':'address';
  const row=db.prepare(`SELECT data FROM trades WHERE ${column}=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1`).get(token.address,now-86400);
  const latest=db.prepare(`SELECT data FROM trades WHERE ${column}=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1`).get(token.address,now);
  if(!row||!latest)return null;
  const old=JSON.parse(row.data),next=JSON.parse(latest.data);
  if(old.timestamp<now-90000||next.timestamp<now-3600||!(old.priceQuote>0)||!(next.priceQuote>0))return null;
  return {percent:(next.priceQuote/old.priceQuote-1)*100,interval:'24h',basis:'Confirmed execution prices in the trading pair; includes trader fees',from:old.timestamp,to:next.timestamp};
}

const EMPTY_ACTIVITY = Object.freeze({ volume24h: 0, trades24h: 0, buys24h: 0, sells24h: 0, lastTradeAt: null, lastBuyAt: null });
/**
 * Trading activity per token from an index database: volume over the last 24 hours (in the pair
 * asset, including trader fees), trade counts, and the latest trade and buy times (seconds).
 * One pass over the last day plus two grouped queries, so a listing of every token stays cheap.
 */
export function indexedActivity(db, now = Math.floor(Date.now() / 1000)) {
  const column = db.prepare('PRAGMA table_info(trades)').all().some(c => c.name === 'mint') ? 'mint' : 'address';
  const map = new Map();
  const get = key => { let row = map.get(key); if (!row) { row = { ...EMPTY_ACTIVITY }; map.set(key, row); } return row; };
  for (const row of db.prepare(`SELECT ${column} AS token, data FROM trades WHERE timestamp > ?`).iterate(now - 86400)) {
    const trade = JSON.parse(row.data), entry = get(row.token);
    entry.volume24h += Math.max(0, Number(trade.quoteAmount) || 0); entry.trades24h++;
    if (trade.side === 'buy') entry.buys24h++; else entry.sells24h++;
  }
  for (const row of db.prepare(`SELECT ${column} AS token, MAX(timestamp) AS last FROM trades GROUP BY ${column}`).all()) get(row.token).lastTradeAt = row.last;
  for (const row of db.prepare(`SELECT ${column} AS token, MAX(timestamp) AS last FROM trades WHERE json_extract(data, '$.side') = 'buy' GROUP BY ${column}`).all()) get(row.token).lastBuyAt = row.last;
  return map;
}
/** The activity fields for one token (zeros when it has never traded). */
export function activityOf(map, address) { return { ...(map.get(address) ?? map.get(String(address).toLowerCase()) ?? EMPTY_ACTIVITY) }; }

/* ---------- Explore model (pure; shared by the web app and tests) ---------- */
export const EXPLORE_TABS = ['trending', 'marketcap', 'new', 'lastsale', 'graduating'];
export const PAIR_FILTERS = ['all', 'native', 'usdc', 'xstock', 'token'];
export const PER_PAGE = 8;
const identityOf = t => `${t.network ?? 'local'}:${t.address}`;
const capQuote = t => Number(t.spotPrice ?? 0) * Number(t.supply ?? 0);
const progress = t => { const cap = Number(t.saleCap ?? t.supply); return cap > 0 ? Math.min(1, Number(t.sold ?? 0) / cap) : 0; };
/** 24h volume in dollars, or null when the pair asset has no fresh dollar reference. */
export function volumeUsd(token, now = nowSeconds()) { const rate = freshUsd(token, now); return rate === null ? null : Number(token.volume24h ?? 0) * rate; }
/** Market cap (price × the full supply) in dollars, or null without a fresh dollar reference. */
export function marketCapUsd(token, now = nowSeconds()) { const rate = freshUsd(token, now); return rate === null ? null : capQuote(token) * rate; }
/** Name, ticker, token address (prefix) or creator address (exact) match. */
export function matchesQuery(token, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  if (`${token.name ?? ''} ${token.symbol ?? ''} ${token.metadata?.name ?? ''} ${token.metadata?.symbol ?? ''}`.toLowerCase().includes(q)) return true;
  if (q.length >= 4 && String(token.address ?? '').toLowerCase().startsWith(q)) return true;
  return q.length >= 32 && String(token.creator ?? '').toLowerCase() === q;
}
const pairOf = t => PAIR_FILTERS.includes(t.pair) ? t.pair : 'native';
// Higher first; nulls (unknown) after every known value.
const desc = (a, b) => (a === null || a === undefined) && (b === null || b === undefined) ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : b - a;
/**
 * Order for the "Trending" tab and strip: dollar volume over 24 hours; tokens whose pair has no dollar
 * reference follow, by their trade count; tokens that did not trade follow by latest trade, then age.
 */
function trendingOrder(now) {
  return (a, b) => {
    const va = Number(a.volume24h) > 0, vb = Number(b.volume24h) > 0;
    if (va !== vb) return va ? -1 : 1;
    return desc(volumeUsd(a, now), volumeUsd(b, now)) || (b.trades24h ?? 0) - (a.trades24h ?? 0) || desc(a.lastTradeAt, b.lastTradeAt) || (b.created ?? 0) - (a.created ?? 0);
  };
}
const ORDERS = {
  trending: trendingOrder,
  marketcap: now => (a, b) => desc(marketCapUsd(a, now), marketCapUsd(b, now)) || capQuote(b) - capQuote(a),
  new: () => (a, b) => (b.created ?? 0) - (a.created ?? 0),
  lastsale: () => (a, b) => desc(a.lastBuyAt, b.lastBuyAt) || (b.created ?? 0) - (a.created ?? 0),
  // Closest to graduation: curves waiting to migrate first, then by how much of the curve has sold.
  graduating: () => (a, b) => Number(!!b.complete) - Number(!!a.complete) || progress(b) - progress(a),
};
/**
 * Filters and orders Explore. Returns the ordered list plus chip counts: pair counts honour the chain
 * filter and search, chain counts honour the pair filter and search, so each chip says what it would show.
 */
export function exploreModel(tokens, { tab = 'trending', pair = 'all', chain = 'all', query = '' } = {}, now = nowSeconds()) {
  const searched = tokens.filter(t => matchesQuery(t, query));
  const inChain = t => chain === 'all' || (t.network ?? 'local') === chain;
  const inPair = t => pair === 'all' || pairOf(t) === pair;
  const pairs = Object.fromEntries(PAIR_FILTERS.map(k => [k, 0])), chains = { all: 0 };
  for (const t of searched) {
    if (inChain(t)) { pairs.all++; pairs[pairOf(t)]++; }
    if (inPair(t)) { chains.all++; const key = t.network ?? 'local'; chains[key] = (chains[key] ?? 0) + 1; }
  }
  const order = (ORDERS[tab] ?? ORDERS.trending)(now);
  const items = searched.filter(t => inChain(t) && inPair(t) && (tab !== 'graduating' || !t.graduated))
    .sort((a, b) => order(a, b) || identityOf(a).localeCompare(identityOf(b)));
  return { items, counts: { pair: pairs, chain: chains } };
}
/** One page of a list: page is clamped into range. */
export function pageOf(items, page = 1, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(items.length / perPage)), at = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  return { page: at, pages, from: items.length ? (at - 1) * perPage + 1 : 0, to: Math.min(items.length, at * perPage), items: items.slice((at - 1) * perPage, at * perPage) };
}
/** Page buttons with gaps: [1, '…', 4, 5, 6, '…', 34]. */
export function pageButtons(page, pages) {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages));
  if (page <= 3) [2, 3, 4].forEach(p => p <= pages && keep.add(p));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach(p => p >= 1 && keep.add(p));
  const out = []; let last = 0;
  for (const p of [...keep].sort((a, b) => a - b)) { if (p - last > 1) out.push('…'); out.push(p); last = p; }
  return out;
}
/** Tokens that traded in the last 24 hours, in trending order. Empty means the strip stays hidden. */
export function trendingTokens(tokens, limit = 10, now = nowSeconds()) {
  const order = trendingOrder(now);
  return tokens.filter(t => Number(t.volume24h) > 0).sort((a, b) => order(a, b) || identityOf(a).localeCompare(identityOf(b))).slice(0, limit);
}
/**
 * Creators ranked by the dollar volume their launches traded in the last 24 hours. Only volume with a
 * fresh dollar reference counts; `partial` marks creators with other volume left out of the total.
 */
export function topCreators(tokens, limit = 10, now = nowSeconds()) {
  const by = new Map();
  for (const t of tokens) {
    if (!t.creator || !(Number(t.volume24h) > 0)) continue;
    const solana = String(t.network ?? '').startsWith('solana'), key = solana ? t.creator : String(t.creator).toLowerCase();
    const row = by.get(key) ?? { creator: t.creator, network: t.network ?? 'local', volumeUsd: 0, tokens: 0, partial: false };
    const usd = volumeUsd(t, now);
    if (usd === null) row.partial = true; else row.volumeUsd += usd;
    row.tokens++; by.set(key, row);
  }
  return [...by.values()].filter(r => r.volumeUsd > 0).sort((a, b) => b.volumeUsd - a.volumeUsd || a.creator.localeCompare(b.creator)).slice(0, limit);
}
/** Recent buys joined to the listed token (for its market cap and pair); trades of unknown tokens drop out. */
export function feedRows(trades, tokens, limit = 20) {
  const index = new Map(tokens.map(t => [`${t.network ?? 'local'}:${String(t.address).toLowerCase()}`, t]));
  return (trades ?? []).filter(t => t.side === 'buy').map(trade => ({ trade, token: index.get(`${trade.network ?? 'local'}:${String(trade.address).toLowerCase()}`) }))
    .filter(row => row.token).slice(0, limit);
}
/** Reads and writes the Explore view state in the hash: #/?tab=new&pair=usdc&chain=solana-devnet&q=…&page=2. */
export function exploreStateFromHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const tab = params.get('tab'), pair = params.get('pair');
  return { tab: EXPLORE_TABS.includes(tab) ? tab : 'trending', pair: PAIR_FILTERS.includes(pair) ? pair : 'all', chain: params.get('chain') || 'all', query: (params.get('q') ?? '').slice(0, 100), page: Math.max(1, Math.floor(Number(params.get('page')) || 1)) };
}
export function exploreHash({ tab = 'trending', pair = 'all', chain = 'all', query = '', page = 1 } = {}) {
  const params = new URLSearchParams();
  if (tab !== 'trending') params.set('tab', tab);
  if (pair !== 'all') params.set('pair', pair);
  if (chain !== 'all') params.set('chain', chain);
  if (query.trim()) params.set('q', query.trim());
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text ? `#/?${text}` : '#/';
}
