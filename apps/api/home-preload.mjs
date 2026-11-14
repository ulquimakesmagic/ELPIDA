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
  const tokens = pairTokenReferences(sources.flatMap(({ network, tokens, solana }) => (tokens ?? []).map(t => ({ ...t, network,
    usdReference: usdReferenceFor(solana ? { ...t, network, usdReference: t.pair === 'xstock' ? t.usdReference ?? null : null } : { ...t, network }, prices?.[network] ?? null, now) }))));
  return trendingTokens(tokens, limit, now)
    .map(t => thumbnailUrl(safeImage(t.metadata?.image ?? t.image ?? ''), TREND_IMAGE))
    .filter(src => /^\/api\/content\/[A-Za-z0-9]+\?w=\d+$/.test(src));
}

/** The page head with a high-priority image preload for each URL (attribute-safe: the URLs match a fixed pattern). */
export function withPreloads(html, urls) {
  if (!urls.length || !html.includes('</head>')) return html;
  return html.replace('</head>', urls.map(u => `  <link rel="preload" as="image" href="${u}" fetchpriority="high">\n`).join('') + '</head>');
}
