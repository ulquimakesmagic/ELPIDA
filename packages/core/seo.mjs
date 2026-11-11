// Public, crawlable pages and the SEO files built from them. One list drives the pages, sitemap.xml, llms.txt and the
// tests. Every number comes from packages/core/v2-economics.mjs; claims follow docs/V2_0_CONTRACTS.md and docs/V2_0_SOLANA.md:
// testnet labels stay, no partnership is claimed, and tokenized stocks are described as not live.

import { V2, V2_FEE_SPLIT, V2_PROPOSED_MIN_FEE_BPS } from './v2-economics.mjs';

export const SITE_NAME = 'Elpida';
export const DEFAULT_ORIGIN = 'https://elpida.fun';
export const SITE_TAGLINE = 'Launch tokens with hope on every chain';
export const SITE_DESCRIPTION = 'Elpida is a multichain token launchpad: liquidity locked from launch, a fee the creator picks once, and every fee shared with creators, traders and holders. Currently running on public testnets.';
export const OG_IMAGE_PATH = '/assets/brand/og-image.png?v=mark-20261019';
export const PAGES_UPDATED = '2026-11-12';

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

// Every number below comes from the V2 economics module the contracts and their tests are checked against, so this copy
// cannot drift from what a launch does (audit WEB-01, 11 November 2026).
const usd = e6 => `$${(Number(e6) / 1e6).toLocaleString('en-US')}`;
const pct = bps => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const START = usd(V2.startFdvUsdE6), GRAD = usd(V2.graduationFdvUsdE6), MULTIPLE = `${V2.graduationFdvUsdE6 / V2.startFdvUsdE6}`;
const MIN_FEE = pct(V2_PROPOSED_MIN_FEE_BPS), DEFAULT_FEE = pct(V2.defaultFeeBps), MAX_FEE = pct(V2.maxFeeBps);
const S = V2_FEE_SPLIT;
const SPLIT = `${pct(S.creator)} to the creator, ${pct(S.traderAirdrop)} to a monthly airdrop for traders, ${pct(S.flywheel)} to a flywheel that buys and burns tokens, ${pct(S.holderRewards)} to holder rewards and ${pct(S.treasury)} to the Elpida treasury`;
const FIRST_BUY = pct(V2.firstBuyCapBps);

export const FAQ = [
  ['What is Elpida?', 'Elpida is a multichain token launchpad. A creator launches a token in one transaction, its liquidity is locked from the first trade, and every trading fee is shared between the creator, traders, holders, a buy-and-burn flywheel and the protocol. The name means hope in Greek.'],
  ['Which networks does Elpida support?', `Elpida currently runs on public testnets: ${NETWORKS}. Mainnet is not open to the public.`],
  ['Is Elpida live with real money?', 'No. Elpida is in testnet. Its contracts have not had an independent audit. Do not treat any testnet token as having value, and do not send funds you cannot afford to lose to any contract that has not been audited.'],
  ['How much does it cost to launch a token?', 'The launch fee is $10, paid at the on-chain price in the network\'s native coin, or 10 USDC. Network gas is paid separately in the native coin. On testnets the amounts use test funds.'],
  ['How does the price work?', `Every token has a fixed supply of one billion. It starts at a ${START} market cap and its price follows a fixed curve to ${GRAD}, a ${MULTIPLE}× rise, where it graduates. The price moves with every buy and sell, there is no private allocation, and anyone can sell back down to the starting price. On testnets the sizes are scaled down with the same shape.`],
  ['What happens at graduation?', 'On EVM networks the token trades in one Uniswap v4 pool from launch. Its liquidity is locked from the first trade and stays locked; at graduation the pool simply continues. On Solana, SOL pairs move to a Raydium CPMM pool and other pairs to PumpSwap, with the liquidity locked in a program-controlled account.'],
  ['What are the trading fees?', `The creator picks the token's fee at launch, from ${MIN_FEE} to ${MAX_FEE} (${DEFAULT_FEE} by default), and it never changes. Every fee is split: ${SPLIT}. For the first minute after launch an anti-snipe fee starts at 90% and falls to the token's own fee; the part above the token's fee is locked as liquidity and never paid out.`],
  ['Is there a limit on the creator\'s first buy?', `Yes. The creator may buy in the launch transaction, but that buy can receive at most ${FIRST_BUY} of the supply, and it is shown publicly as "Dev" on the token page.`],
  ['What about test tokens launched before V2?', 'They keep the rules they launched with: an earlier curve that graduates into a locked pool and a fee split between the protocol and the creator. Each token page says which model the token uses.'],
  ['Can anyone change a token after launch?', 'No. Supply is fixed, the token metadata is set once in the launch transaction and has no setter, and the fee and curve are immutable.'],
  ['Can I trade tokenized stocks on Elpida?', 'Only as test assets on testnets. Elpida has no partnership with any issuer. Issuers of tokenized stocks can block, pause or burn tokens, which would affect any pool holding them.'],
  ['Is this financial advice?', 'No. Elpida is software. Tokens launched on any launchpad are highly volatile and can lose all of their value. Nothing on this site is investment, legal or tax advice.'],
];

const HOW_STEPS = [
  ['Pick a network and a trading pair', `Choose where the token lives (${NETWORKS}) and what buyers pay with: the native coin or USDC, plus approved pairs where available.`],
  ['Describe the token and choose its fee', `Add a name, ticker, image and links, and pick the token's fee, from ${MIN_FEE} to ${MAX_FEE}. Metadata and fee are written once in the launch transaction.`],
  ['Launch in one transaction', `Pay the $10 launch fee (native coin at the on-chain price, or 10 USDC). A creator can make an optional first buy in the same transaction, capped at ${FIRST_BUY} of the supply and shown publicly as "Dev".`],
  ['Trade with locked liquidity', `The token starts at a ${START} market cap. Price rises with each buy and falls with each sell along a fixed curve to ${GRAD}. On EVM networks this happens inside one Uniswap v4 pool whose liquidity is locked from launch.`],
  ['Share the fees', `Every trade pays the token's fee: ${SPLIT}.`],
];

const FEE_ROWS = [
  ['Launch fee', '$10 in the native coin at the on-chain price, or 10 USDC.'],
  ['Trading fee', `Chosen by the creator at launch, ${MIN_FEE}–${MAX_FEE} (${DEFAULT_FEE} by default); fixed for the token's life on EVM networks.`],
  ['Fee split', `${SPLIT}.`],
  ['First-minute protection', 'Fee starts at 90% and falls linearly to the token\'s own fee over 60 seconds. The surplus is locked as liquidity, never paid out.'],
  ['Solana after graduation', 'SOL pairs trade in a Raydium CPMM pool (its own 1% fee tier); other pairs in PumpSwap. Fees earned by the locked position are harvested and shared the same way.'],
  ['Network gas', 'Always paid in the network\'s native coin.'],
];

const SAFETY_POINTS = [
  ['Fixed supply and immutable metadata', 'Every token has one billion units minted once. Metadata is set in the launch transaction and cannot be edited afterwards.'],
  ['A fixed fee and curve', 'The fee and curve are set at launch. There is no admin switch to reprice a live token or change its fee.'],
  ['Locked liquidity', 'On EVM networks the pool\'s liquidity is locked from the first trade; nobody, including Elpida, can add to or remove it. On Solana the graduated position is locked in a program account.'],
  ['A capped first buy', `The creator\'s first buy can receive at most ${FIRST_BUY} of the supply, and the creator\'s holding is shown on the token page.`],
  ['Isolated fee payouts', 'If one fee recipient cannot receive funds, the others are still paid and the failed amount stays owed.'],
];

const SAFETY_LIMITS = [
  'Elpida is in testnet and its contracts have not had an independent audit.',
  'Launchpad tokens are highly volatile and most lose value. Only trade what you can afford to lose.',
  'Tokenized stocks are test assets only. Their issuers can block accounts, pause tokens and burn balances, which can freeze or drain any pool that holds them.',
];

export const PAGES = [
  {
    path: '/learn', title: 'Learn how Elpida works', h1: 'Learn how Elpida works',
    description: 'Guides to Elpida, a multichain token launchpad: how a launch works, what it costs, how safety is built in, and answers to common questions.',
    lead: 'Short, plain guides to launching and trading on Elpida. Elpida currently runs on public testnets.',
    sections: [], links: true,
  },
  {
    path: '/learn/how-it-works', title: 'How an Elpida token launch works', h1: 'How an Elpida launch works',
    description: 'How an Elpida token is created in one transaction, priced on a fixed curve with liquidity locked from launch, and how its fees are shared.',
    lead: 'A token goes from one transaction to a shared, locked market in five steps. Elpida currently runs on testnets.',
    steps: HOW_STEPS,
    sections: [
      { h2: 'Why a fixed curve', body: ['A fixed curve prices a token automatically from how much has been bought, so there is always a price and always liquidity on the other side. Elpida uses one shape for every token, so the rules are the same for everyone.'] },
      { h2: 'Which networks', body: [`Elpida runs on ${NETWORKS}. Each network launches natively: on EVM networks every token trades in its own Uniswap v4 pool, and on Solana graduated tokens move to Raydium or PumpSwap.`] },
    ],
  },
  {
    path: '/learn/fees-and-rewards', title: 'Elpida fees and creator rewards', h1: 'Fees and creator rewards',
    description: 'Every fee on Elpida in one place: the $10 launch fee, the fee each token picks at launch, first-minute protection and how every fee is shared five ways.',
    lead: 'Every charge, who receives it, and when it applies.',
    table: FEE_ROWS,
    sections: [
      { h2: 'Who receives each fee', body: [`${SPLIT}. The creator chooses at launch where the creator share goes: their wallet, other verified wallets, X accounts or websites, or the token\'s holders.`] },
      { h2: 'What is never paid out', body: ['The anti-snipe surplus above the token\'s own fee is locked as liquidity. It is not creator or protocol revenue.'] },
    ],
  },
  {
    path: '/learn/safety', title: 'Safety and risks on Elpida', h1: 'Safety and risks',
    description: 'What Elpida builds in to protect traders (fixed supply and fee, liquidity locked from launch, a capped first buy) and what it cannot protect against.',
    lead: 'What is built in, and what is not. Please read both parts.',
    points: SAFETY_POINTS,
    sections: [{ h2: 'What Elpida cannot protect you from', list: SAFETY_LIMITS }],
  },
  {
    path: '/learn/faq', title: 'Elpida FAQ: networks, fees and safety', h1: 'Frequently asked questions',
    description: 'Answers about Elpida: networks, launch cost, the price curve, graduation, fees and how they are shared, immutability, tokenized stocks and risk.',
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
