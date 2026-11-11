// Public, crawlable pages and the SEO files built from them. One list drives the pages, sitemap.xml, llms.txt and the
// tests. Every claim here comes from the repo's own docs (MODEL_10.md, DEX_DESTINATIONS_AND_FEES.md, README status):
// testnet labels stay, no partnership is claimed, and tokenized stocks are described as not live.

export const SITE_NAME = 'Elpida';
export const DEFAULT_ORIGIN = 'https://elpida.fun';
export const SITE_TAGLINE = 'Launch tokens with hope on every chain';
export const SITE_DESCRIPTION = 'Elpida is a multichain token launchpad: fair bonding curves, locked liquidity and fees you can see. Currently running on a local simulation and public testnets.';
export const OG_IMAGE_PATH = '/assets/brand/og-image.png?v=mark-20261019';
export const PAGES_UPDATED = '2026-10-20';

/** The canonical origin: ELPIDA_CANONICAL_ORIGIN when it is a valid https origin, otherwise elpida.fun. */
export function canonicalOrigin(env = process.env) {
  const value = env.ELPIDA_CANONICAL_ORIGIN;
  if (!value) return DEFAULT_ORIGIN;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch { /* fall through */ }
  return DEFAULT_ORIGIN;
}

const NETWORKS = 'Base Sepolia, Ethereum Sepolia, BNB Chain Testnet, Robinhood Chain Testnet and Solana Devnet';

export const FAQ = [
  ['What is Elpida?', 'Elpida is a multichain token launchpad. A creator launches a token in one transaction, buyers trade it on a fair bonding curve, and when the curve completes its liquidity moves to a decentralized exchange pool. The name means hope in Greek.'],
  ['Which networks does Elpida support?', `Elpida currently runs on a local simulation and on public testnets: ${NETWORKS}. Mainnet is not open to the public.`],
  ['Is Elpida live with real money?', 'No. Elpida is in testnet. Its contracts have not been audited. Do not treat any testnet token as having value, and do not send funds you cannot afford to lose to any contract that has not been audited.'],
  ['How much does it cost to launch a token?', 'The launch fee is $10, paid at the on-chain price in the network\'s native coin, or 10 USDC. Network gas is paid separately in the native coin. On testnets the amounts use test funds.'],
  ['How does the bonding curve work?', 'Every token has a fixed supply of one billion and starts on a curve that begins at a $5,000 fully diluted value and completes at $50,000, a tenfold rise. The price moves with every buy and sell, there is no private allocation, and anyone can sell back into the curve while it is open.'],
  ['What happens when the curve completes?', 'The curve\'s liquidity moves to a decentralized exchange. On EVM networks it becomes a Uniswap v3 full-range position that is locked permanently, and its trading fees are split between the protocol and the creator. On Solana, SOL pairs move to a Raydium CPMM pool (1% fee tier) and other pairs to PumpSwap, with the liquidity locked in a program-controlled account.'],
  ['What if graduation fails?', 'If a completed curve has not moved to its pool within 24 hours, anyone can reopen it for trading. Every holder can then sell, and completing the curve restarts the timer.'],
  ['What are the trading fees?', 'The curve charges 1.25% per trade, split evenly between the protocol and the creator. For the first minute after launch an anti-snipe fee starts at 90% and falls to 1.25%; the surplus above 1.25% is locked into the graduation liquidity and is never paid out as revenue.'],
  ['Can anyone change a token after launch?', 'No. Supply is fixed, the token metadata is set once in the launch transaction and has no setter, and the curve parameters are immutable.'],
  ['Can I trade tokenized stocks on Elpida?', 'Not yet. Tokenized stocks from Robinhood, Coinbase, Binance and xStocks are being evaluated, and every live capability is switched off until it has been verified. Elpida has no partnership with any of these providers. Issuers of tokenized stocks can block, pause or burn tokens, which would affect any curve or pool holding them.'],
  ['Is this financial advice?', 'No. Elpida is software. Tokens launched on any launchpad are highly volatile and can lose all of their value. Nothing on this site is investment, legal or tax advice.'],
];

const HOW_STEPS = [
  ['Pick a network and a trading pair', `Choose where the token lives (${NETWORKS}) and what buyers pay with: the native coin or USDC, plus approved pairs where available.`],
  ['Describe the token and set rewards', 'Add a name, symbol, image and links. Metadata is written once in the launch transaction. Creators choose where their share of trading fees goes.'],
  ['Launch in one transaction', 'Pay the $10 launch fee (native coin at the on-chain price, or 10 USDC). A creator can make an optional first buy in the same transaction, charged only the base fee and shown publicly as "Dev" on the token page.'],
  ['Trade on the bonding curve', 'The token starts at a $5,000 fully diluted value. Price rises with each buy and falls with each sell along a fixed curve that finishes at $50,000. On testnets the sizes are scaled down to $50 and $500 with the same shape.'],
  ['Graduate to a decentralized exchange', 'When the supply for sale is gone, liquidity moves to Uniswap v3 on EVM networks or Raydium (SOL pairs) and PumpSwap on Solana, with the position locked permanently.'],
];

const FEE_ROWS = [
  ['Launch fee', '$10 in the native coin at the on-chain price, or 10 USDC.'],
  ['Curve trading fee', '1.25% of each trade, split 50% protocol and 50% creator.'],
  ['First-minute protection', 'Fee starts at 90% and falls linearly to 1.25% over 60 seconds. The surplus above 1.25% is locked into graduation liquidity.'],
  ['Pool fees after graduation', 'The exchange pool\'s own fee applies (1% on the Base Sepolia test pool). Fees earned by the locked position are split 50/50 between the protocol and the creator side.'],
  ['Network gas', 'Always paid in the network\'s native coin.'],
];

const SAFETY_POINTS = [
  ['Fixed supply and immutable metadata', 'Every token has one billion units minted once. Metadata is set in the launch transaction and cannot be edited afterwards.'],
  ['A fixed curve', 'Curve parameters are immutable. There is no admin switch to reprice a live curve.'],
  ['Locked liquidity', 'At graduation the pool position is locked permanently. It can collect fees but its principal cannot be withdrawn.'],
  ['A way out if graduation stalls', 'If graduation has not happened 24 hours after the curve completes, anyone can reopen it for trading.'],
  ['Visible creator behaviour', 'The creator\'s first buy and current holding are recorded and shown, for example "Dev 4.73% to 4.73%".'],
  ['Isolated fee payouts', 'If one fee recipient cannot receive funds, the other is still paid and the failed amount stays owed.'],
];

const SAFETY_LIMITS = [
  'Elpida is in testnet and its contracts have not been audited. A professional audit is planned before any mainnet use.',
  'Bonding-curve tokens are highly volatile and most lose value. Only trade what you can afford to lose.',
  'Tokenized stocks are not live. If they are offered later, their issuers can block accounts, pause tokens and burn balances, which can freeze or drain any curve or pool that holds them. Elpida would show a warning before any such pair is used.',
];

export const PAGES = [
  {
    path: '/learn', title: 'Learn how Elpida works', h1: 'Learn how Elpida works',
    description: 'Guides to Elpida, a multichain token launchpad: how a launch works, what it costs, how safety is built in, and answers to common questions.',
    lead: 'Short, plain guides to launching and trading on Elpida. Elpida currently runs on a local simulation and public testnets.',
    sections: [], links: true,
  },
  {
    path: '/learn/how-it-works', title: 'How an Elpida token launch works', h1: 'How an Elpida launch works',
    description: 'From launch to graduation: how Elpida tokens are created, priced on a fair bonding curve and moved to a locked decentralized exchange pool.',
    lead: 'A token goes from one transaction to a locked exchange pool in five steps. Elpida currently runs on testnets.',
    steps: HOW_STEPS,
    sections: [
      { h2: 'Why a bonding curve', body: ['A bonding curve prices a token automatically from how much has been bought, so there is always a price and always a buyer or seller on the other side while the curve is open. Elpida uses one fixed shape for every token, so the rules are the same for everyone.'] },
      { h2: 'Which networks', body: [`Elpida runs on ${NETWORKS}, plus a local simulation. Each network launches natively, and the graduated pool uses that network's main decentralized exchange.`] },
    ],
  },
  {
    path: '/learn/fees-and-rewards', title: 'Elpida fees and creator rewards', h1: 'Fees and creator rewards',
    description: 'Every fee on Elpida in one place: the $10 launch fee, the 1.25% curve fee, first-minute protection, pool fees and how creator rewards are split.',
    lead: 'Every charge, who receives it, and when it applies.',
    table: FEE_ROWS,
    sections: [
      { h2: 'Creator share', body: ['Creators receive half of the curve trading fee and half of the locked pool position\'s earnings. Where a creator\'s reward goes is chosen at launch. Options for sharing rewards with holders are being built and tested, and their availability varies by network.'] },
      { h2: 'What is never paid out', body: ['The anti-snipe surplus above the base fee is locked into graduation liquidity. It is not creator or protocol revenue.'] },
    ],
  },
  {
    path: '/learn/safety', title: 'Safety and risks on Elpida', h1: 'Safety and risks',
    description: 'What Elpida builds in to protect traders (fixed supply, locked liquidity, a reopen escape hatch) and an honest list of what it cannot protect against.',
    lead: 'What is built in, and what is not. Please read both parts.',
    points: SAFETY_POINTS,
    sections: [{ h2: 'What Elpida cannot protect you from', list: SAFETY_LIMITS }],
  },
  {
    path: '/learn/faq', title: 'Elpida FAQ: networks, fees and safety', h1: 'Frequently asked questions',
    description: 'Answers about Elpida: networks, launch cost, the bonding curve, graduation, fees, immutability, tokenized stocks and risk.',
    lead: 'Quick answers to the questions we hear most.',
    faq: FAQ, sections: [],
  },
];

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** JSON for a <script type="application/ld+json"> block; "<" is escaped so the data can never close the tag. */
export const jsonLd = data => JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const url = (origin, path) => `${origin}${path}`;

export function websiteJsonLd(origin = DEFAULT_ORIGIN) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${origin}/#organization`, name: SITE_NAME, url: `${origin}/`, logo: { '@type': 'ImageObject', url: `${origin}/assets/brand/icon-512.png`, width: 512, height: 512 }, slogan: SITE_TAGLINE, description: SITE_DESCRIPTION },
      { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: SITE_NAME, description: SITE_DESCRIPTION, inLanguage: 'en', publisher: { '@id': `${origin}/#organization` } },
      { '@type': 'SoftwareApplication', '@id': `${origin}/#app`, name: SITE_NAME, applicationCategory: 'FinanceApplication', operatingSystem: 'Any (web browser)', url: `${origin}/`, description: SITE_DESCRIPTION, publisher: { '@id': `${origin}/#organization` } },
    ],
  };
}

export function pageJsonLd(page, origin = DEFAULT_ORIGIN) {
  const here = url(origin, page.path);
  const crumbs = [{ '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${origin}/` }];
  if (page.path !== '/learn') crumbs.push({ '@type': 'ListItem', position: 2, name: 'Learn', item: url(origin, '/learn') });
  crumbs.push({ '@type': 'ListItem', position: crumbs.length + 1, name: page.h1, item: here });
  const graph = [
    { '@type': 'WebPage', '@id': `${here}#webpage`, url: here, name: page.title, description: page.description, inLanguage: 'en', dateModified: PAGES_UPDATED, isPartOf: { '@id': `${origin}/#website` }, breadcrumb: { '@id': `${here}#breadcrumb` } },
    { '@type': 'BreadcrumbList', '@id': `${here}#breadcrumb`, itemListElement: crumbs },
  ];
  if (page.faq) graph.push({ '@type': 'FAQPage', '@id': `${here}#faq`, mainEntity: page.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  if (page.steps) graph.push({ '@type': 'HowTo', '@id': `${here}#howto`, name: page.h1, step: page.steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text })) });
  return { '@context': 'https://schema.org', '@graph': graph };
}

function bodyHtml(page) {
  const out = [];
  if (page.steps) out.push('<ol class="lp-steps">' + page.steps.map(([h, t]) => `<li><h2>${esc(h)}</h2><p>${esc(t)}</p></li>`).join('') + '</ol>');
  if (page.table) out.push('<table class="lp-table"><caption class="lp-sr">Elpida fees</caption><thead><tr><th scope="col">Charge</th><th scope="col">Details</th></tr></thead><tbody>' + page.table.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('') + '</tbody></table>');
  if (page.points) out.push('<ul class="lp-points">' + page.points.map(([h, t]) => `<li><h2>${esc(h)}</h2><p>${esc(t)}</p></li>`).join('') + '</ul>');
  for (const s of page.sections ?? []) {
    out.push(`<section><h2>${esc(s.h2)}</h2>${(s.body ?? []).map(p => `<p>${esc(p)}</p>`).join('')}${s.list ? '<ul>' + s.list.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>' : ''}</section>`);
  }
  if (page.faq) out.push('<div class="lp-faq">' + page.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('') + '</div>');
  if (page.links) out.push('<ul class="lp-cards">' + PAGES.filter(p => p.path !== '/learn').map(p => `<li><a href="${p.path}"><strong>${esc(p.h1)}</strong><span>${esc(p.description)}</span></a></li>`).join('') + '</ul>');
  return out.join('\n');
}

/** A complete, CSP-safe HTML document for a public page: no inline scripts or styles. */
export function renderPage(page, origin = DEFAULT_ORIGIN) {
  const here = url(origin, page.path), image = `${origin}${OG_IMAGE_PATH}`;
  const nav = [['/', 'Explore'], ['/#/launch', 'Launch a token'], ['/learn', 'Learn']].map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
  const foot = PAGES.map(p => `<a href="${p.path}">${esc(p.path === '/learn' ? 'Learn' : p.h1)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(page.title)} · ${SITE_NAME}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#08090b">
<link rel="canonical" href="${here}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${here}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${image}">
<link rel="icon" href="/assets/brand/favicon.svg?v=mark-20261019" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png?v=mark-20261019">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/learn.css">
<script src="/theme-boot.js"></script>
<script type="application/ld+json">${jsonLd(pageJsonLd(page, origin))}</script>
</head>
<body class="lp">
<a class="lp-skip" href="#main">Skip to content</a>
<header class="lp-top"><a class="lp-brand" href="/" aria-label="Elpida home"><img class="lp-logo brand-dark" src="/assets/brand/elpida-wordmark-dark.svg?v=mark-20261019" alt="Elpida" width="120" height="32"><img class="lp-logo brand-light" src="/assets/brand/elpida-wordmark.svg?v=mark-20261019" alt="" width="120" height="32"></a><nav aria-label="Main">${nav}</nav></header>
<main id="main" class="lp-main">
<article>
<h1>${esc(page.h1)}</h1>
<p class="lp-lead">${esc(page.lead)}</p>
${bodyHtml(page)}
<p class="lp-cta"><a class="lp-btn" href="/#/launch">Launch a token on testnet</a> <a class="lp-link" href="/">Explore tokens</a></p>
<p class="lp-note">Updated ${PAGES_UPDATED}. Elpida runs on a local simulation and public testnets, its contracts are not audited, and nothing here is financial advice.</p>
</article>
</main>
<footer class="lp-foot"><nav aria-label="Learn">${foot}</nav><p>${SITE_NAME} means hope in Greek.</p></footer>
</body>
</html>
`;
}

export function renderSitemap(origin = DEFAULT_ORIGIN) {
  const entries = [{ path: '/', changefreq: 'daily', priority: '1.0', image: `${origin}${OG_IMAGE_PATH.split('?')[0]}` }, ...PAGES.map(p => ({ path: p.path, changefreq: 'monthly', priority: p.path === '/learn' ? '0.8' : '0.7' }))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.map(e => `  <url>
    <loc>${esc(url(origin, e.path))}</loc>
    <lastmod>${PAGES_UPDATED}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>${e.image ? `
    <image:image><image:loc>${esc(e.image)}</image:loc><image:title>${SITE_NAME}: ${esc(SITE_TAGLINE)}</image:title></image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`;
}

export function renderRobots(origin = DEFAULT_ORIGIN) {
  return `# ${SITE_NAME} robots.txt
User-agent: *
Allow: /
Disallow: /api/
Disallow: /health
Disallow: /ready

Sitemap: ${origin}/sitemap.xml
`;
}

export function renderLlms(origin = DEFAULT_ORIGIN) {
  return `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

Elpida means hope in Greek. It is in testnet; its contracts are not audited and nothing here is financial advice.

## Guides
${PAGES.map(p => `- [${p.h1}](${url(origin, p.path)}): ${p.description}`).join('\n')}

## App
- [Explore and launch tokens](${origin}/): the single-page app for creating and trading tokens.
`;
}

/** Plain-text summary used inside <noscript> on the app shell so crawlers without JavaScript still see real content. */
export function noscriptHtml() {
  return `<noscript>
  <main class="lp-main">
    <h1>Elpida: ${esc(SITE_TAGLINE)}</h1>
    <p>${esc(SITE_DESCRIPTION)} Elpida needs JavaScript to run the app. These guides work without it:</p>
    <ul>${PAGES.map(p => `<li><a href="${p.path}">${esc(p.h1)}</a></li>`).join('')}</ul>
  </main>
</noscript>`;
}
