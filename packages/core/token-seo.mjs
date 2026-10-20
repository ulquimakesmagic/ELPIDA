// Server-rendered landing page for one token, so a shared link shows a real preview (name, symbol, image, stats) on X,
// Telegram, Discord and search. The SPA is hash-routed, so these pages live at real paths: /token/<network>/<address>.
// Rules: every value from a token is user content and is escaped; testnet and simulation tokens are NOT indexable
// (noindex) because they carry no value and anyone can create one; images only come from the existing safe resolver.
import { tokenWalletImage } from '../../apps/web/wallet-token.mjs';
import { OG_IMAGE_PATH, SITE_NAME } from './seo.mjs';

export const TOKEN_PATH = /^\/token\/([a-z0-9-]{3,40})\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Plain one-line text from user content: no control characters, collapsed whitespace, bounded length. */
export function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
const num = (value, digits = 4) => { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : null; };

/** Short factual stats line; only fields the indexer actually returned, nothing invented. */
export function tokenFacts(token) {
  const facts = [], quote = cleanText(token.quoteSymbol, 12) || 'native';
  const fdv = num(token.fdvQuote, 4); if (fdv) facts.push(`FDV ${fdv} ${quote}`);
  if (token.priceUsd != null && Number.isFinite(Number(token.priceUsd))) facts.push(`$${Number(token.priceUsd).toPrecision(4)}`);
  facts.push(token.graduated ? 'Graduated to a DEX pool' : token.complete ? 'Curve complete, awaiting graduation' : 'Trading on the bonding curve');
  return facts;
}

export function tokenMeta(token, networkName) {
  const name = cleanText(token.name, 48) || 'Unnamed token', symbol = cleanText(token.symbol, 16).replace(/^\$/, '') || '?';
  const about = cleanText(token.metadata?.description, 110);
  const description = cleanText(`${about ? about + ' ' : ''}${name} ($${symbol}) on ${networkName}, a test network. ${tokenFacts(token).join('. ')}. Not financial advice.`, 200);
  return { name, symbol, title: cleanText(`${name} ($${symbol}) on ${networkName}`, 70), description };
}

/** HTML for a token that exists. `origin` is the canonical https origin. */
export function renderTokenPage({ token, network, networkName, origin, testnet = true }) {
  const address = token.address, here = `${origin}/token/${network}/${address}`;
  const meta = tokenMeta(token, networkName);
  const own = tokenWalletImage({ ...token, network }, origin);
  const image = own ?? `${origin}${OG_IMAGE_PATH}`, imageAlt = own ? `${meta.name} logo` : 'Elpida logo';
  const app = `/#/token/${address}?network=${encodeURIComponent(network)}`;
  const robots = testnet ? 'noindex, follow' : 'index, follow, max-image-preview:large';
  const facts = tokenFacts(token).map(f => `<li>${esc(f)}</li>`).join('');
  const about = cleanText(token.metadata?.description, 400);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(meta.title)} · ${SITE_NAME}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="#08090b">
<link rel="canonical" href="${esc(here)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(here)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta name="twitter:card" content="${own ? 'summary' : 'summary_large_image'}">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(imageAlt)}">
<link rel="icon" href="/assets/brand/favicon.svg?v=mark-20261019" type="image/svg+xml">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/learn.css">
<script src="/theme-boot.js"></script>
<script type="module" src="/token-landing.mjs"></script>
</head>
<body class="lp">
<header class="lp-top"><a class="lp-brand" href="/" aria-label="Elpida home"><img class="lp-logo brand-dark" src="/assets/brand/elpida-wordmark-dark.svg?v=mark-20261019" alt="Elpida" width="120" height="32"><img class="lp-logo brand-light" src="/assets/brand/elpida-wordmark.svg?v=mark-20261019" alt="" width="120" height="32"></a><nav aria-label="Main"><a href="/">Explore</a><a href="/learn">Learn</a></nav></header>
<main id="main" class="lp-main">
<article data-app="${esc(app)}">
<h1>${esc(meta.name)} <span class="lp-sym">$${esc(meta.symbol)}</span></h1>
<p class="lp-lead">${esc(networkName)}${testnet ? ', a test network. Test tokens have no value.' : ''}</p>
${about ? `<p>${esc(about)}</p>` : ''}
<ul class="lp-points lp-facts">${facts}</ul>
<p class="lp-cta"><a class="lp-btn" href="${esc(app)}">Open ${esc(meta.symbol)} in Elpida</a></p>
<p class="lp-note">Contract ${esc(address)}. Elpida contracts are not audited and nothing here is financial advice.</p>
</article>
</main>
</body>
</html>
`;
}

/** Plain not-found page so a bad link never looks like a real token. Not indexable. */
export function renderTokenNotFound({ origin }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token not found · ${SITE_NAME}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/learn.css"><script src="/theme-boot.js"></script>
</head><body class="lp"><main class="lp-main"><h1>Token not found</h1><p class="lp-lead">This token is not indexed on this network yet, or the link is wrong.</p><p class="lp-cta"><a class="lp-btn" href="${esc(origin)}/">Explore tokens</a></p></main></body></html>
`;
}
