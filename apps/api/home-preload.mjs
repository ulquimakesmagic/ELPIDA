// Home page LCP (15 Nov 2026): the largest paint on the home page is the first trending card's logo. Without help the
// browser finds it only after the app has loaded, fetched every network's token list and ranked them (PageSpeed mobile:
// 3.0 s "resource load delay"). The server ranks the same lists the same way (discovery.mjs is shared with the browser)
// and names the first logos in the page head as preloads, so the download starts with the HTML. A logo that no longer
// leads by the time the page ranks costs one small thumbnail and nothing else.
import { trendingTokens, pairTokenReferences } from '../web/discovery.mjs';
import { safeImage, thumbnailUrl } from '../web/ui.mjs';
import { usdReferenceFor } from '../../packages/core/pairs.mjs';

/** The trending cards' thumbnail size in CSS pixels (ui.mjs AVATAR_SIZES['tc-image']). */
const TREND_IMAGE = 256;

/**
 * Thumbnail URLs of the first `limit` trending tokens, as the browser will request them, for this server's own stored
 * logos only (other hosts are not preloaded). `sources`: [{ network, tokens (with 24h activity), solana }].
 */
export function homePreloads({ sources, prices = {}, now = Math.floor(Date.now() / 1000), limit = 2 }) {
  return trendingLogos({ sources, prices, now, limit }).filter(Boolean);
}

/**
 * The first `limit` trending cards in rank order, as { src, name, symbol }: `src` is this site's own thumbnail URL for
 * the logo, or null for an image anywhere else.
 */
export function trendingCards({ sources, prices = {}, now = Math.floor(Date.now() / 1000), limit = 5, imageOf = () => '' }) {
  const tokens = pairTokenReferences(sources.flatMap(({ network, tokens, solana }) => (tokens ?? []).map(t => ({ ...t, network,
    usdReference: usdReferenceFor(solana ? { ...t, network, usdReference: t.pair === 'xstock' ? t.usdReference ?? null : null } : { ...t, network }, prices?.[network] ?? null, now) }))));
  return trendingTokens(tokens, limit, now).map(t => {
    const src = thumbnailUrl(safeImage(t.metadata?.image || t.image || imageOf(t) || ''), TREND_IMAGE);
    return { src: /^\/api\/content\/[A-Za-z0-9]+\?w=\d+$/.test(src) ? src : null, name: String(t.metadata?.name || t.name || '').slice(0, 40), symbol: String(t.metadata?.symbol || t.symbol || '').slice(0, 12) };
  });
}

/** The first `limit` trending cards' logos in rank order: this site's own thumbnail URL, or null for any other image. */
export function trendingLogos(options) { return trendingCards(options).map(c => c.src); }

/** The page head with a high-priority image preload for each URL (attribute-safe: the URLs match a fixed pattern). */
export function withPreloads(html, urls) {
  if (!urls.length || !html.includes('</head>')) return html;
  return html.replace('</head>', urls.map(u => `  <link rel="preload" as="image" href="${u}" fetchpriority="high">\n`).join('') + '</head>');
}

/**
 * The home page's first screen as the app's own loading skeleton (explore-view.mjs exploreSkeleton: same classes, same
 * sizes), with the first trending logos already in their cards. The image is then painted with the HTML instead of after
 * the app has loaded and ranked every list (PageSpeed mobile, 14 Nov: 4.1 s "element render delay"). The app keeps a
 * loading skeleton in place until the lists are read, then draws the real cards over the same space, so nothing moves.
 */
export function homeFirstScreen(items) {
  // Each card: its logo, rank and name over the logo, as the real card shows them, so a slow load reads as loading cards,
  // not as bare pictures. Names come from token metadata: escaped, never trusted as markup.
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const card = i => {
    const item = typeof items[i] === 'string' ? { src: items[i] } : items[i] ?? {}, src = item.src;
    const band = item.name ? `<span class="rank-chip">#${i + 1}</span><div class="tc-band"><h3 class="tc-name">${esc(item.name)}</h3>${item.symbol ? `<span class="tc-ticker">$${esc(item.symbol)}</span>` : ''}</div>` : '';
    return src
      ? `<li class="trend-card trend-skeleton"><div class="tc-media"><div class="avatar tc-image"><img alt="" src="${src}" decoding="async"${i < 2 ? ' fetchpriority="high"' : ''}></div>${band}</div><div class="skeleton trend-skeleton-line"></div></li>`
      : '<li class="trend-card trend-skeleton"><div class="tc-media skeleton"></div><div class="skeleton trend-skeleton-line"></div></li>';
  };
  return '<div class="explore" aria-busy="true"><h1 class="visually-hidden">Explore tokens</h1>'
    + '<section class="home-section trending" aria-hidden="true"><div class="section-head"><div class="section-title"><h2>Trending</h2><span class="section-sub">By 24h volume</span></div></div>'
    + `<div class="scroll-fade"><ul class="trend-track">${[0, 1, 2, 3, 4].map(card).join('')}</ul></div></section>`
    + '<section class="home-section explore-section"><div class="explore-head"><h2>Explore</h2><span class="launched">Loading…</span></div>'
    + '<div class="skeleton explore-controls-skeleton" aria-hidden="true"></div>'
    + `<div class="list-grid">${'<div class="skeleton list-skeleton" aria-hidden="true"></div>'.repeat(6)}</div></section></div>`;
}

/** The home page with its first screen in `#view` (only when the static loading heading is where it is expected). */
export function withFirstScreen(html, items) {
  const start = html.indexOf('<div id="view"'), head = html.indexOf('<div class="page-head">', start), end = head < 0 ? -1 : html.indexOf('</div></div>', head);
  if (!items.some(x => typeof x === 'string' ? x : x?.src) || start < 0 || head < 0 || end < 0) return html;
  return html.slice(0, head) + homeFirstScreen(items) + html.slice(end + '</div></div>'.length);
}

/**
 * The logo of a token whose details are only in its launch metadata document (`metadataURI`, as V2 launches publish
 * them): read from this server's own store, with no network request; '' when the document or its image is not stored
 * here. Mirrors MetadataStore.resolve, which the browser calls for the same token.
 */
export function storedMetadataImage(store, token) {
  try {
    const uri = String(token?.metadataURI ?? ''); if (!uri.startsWith('ipfs://')) return '';
    const record = store.get(uri.slice(7)); if (!record || record.type !== 'application/json') return '';
    const doc = JSON.parse(Buffer.from(record.data, 'base64').toString());
    if (doc.schema !== 'elpida-token-v1') return '';
    const image = String(doc.image ?? '');
    if (!image.startsWith('ipfs://')) return '';
    const cid = image.slice(7);
    return /^[A-Za-z0-9]+$/.test(cid) && store.get(cid) ? `/api/content/${cid}` : '';
  } catch { return ''; }
}
