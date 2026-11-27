// Docs (#/docs): guidance in plain language. Figures come from packages/core/v2-economics.mjs (the V2 launchpad every
// network launches with) and the network registry, so this page cannot drift from the contracts (audit WEB-02,
// 11 November 2026). Nothing here promises mainnet availability.
import { h, icon, copyButton, short } from './ui.mjs';
import { disclaimerPoints, fullDisclaimer } from './consent.mjs';
import { SNIPE_START_BPS, SNIPE_WINDOW_SECONDS } from '/curve-model.mjs';
import { V2, V23_FEE_SPLIT, V2_PROPOSED_MIN_FEE_BPS } from '/v2-economics.mjs';

const usd = e6 => `$${(Number(e6) / 1e6).toLocaleString('en-US')}`;

const SECTIONS = [
  ['risk', 'Risk disclaimer', 'triangle-alert'],
  ['create-your-token', 'Create your token', 'plus'],
  ['choose-your-pair', 'Choose your pair', 'layers'],
  ['trade-and-graduate', 'Trade and graduate', 'trending-up'],
  ['fees-and-rewards', 'Fees and rewards', 'coins'],
  ['contracts', 'Contracts', 'file-text'],
  ['developers', 'Developers', 'code'],
  ['faq', 'FAQ', 'circle-help'],
  ['privacy', 'Privacy and cookies', 'lock'],
];
const pct = bps => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const tile = (title, text) => h('div.dc-tile', h('strong', title), h('p', text));
const note = (kind, glyph, ...children) => h(`p.dc-callout.dc-${kind}`, icon(glyph, 'icon-sm'), h('span', ...children));

function card(index, [key, title], ...children) {
  return h('section.dc-card', { id: `doc-${key}`, 'data-section': key, 'aria-labelledby': `doc-${key}-h` },
    h('div.dc-card-head', h('span.dc-num', String(index + 1).padStart(2, '0')), h('h2', { id: `doc-${key}-h` }, title)), ...children);
}
function explorerLink(net, address) {
  if (!net.explorer) return null;
  const kind = net.kind === 'solana' ? 'address' : 'address';
  return `${net.explorer}/${kind}/${address}${net.kind === 'solana' && net.cluster && net.cluster !== 'mainnet' ? `?cluster=${net.cluster}` : ''}`;
}
function contractCard(net, role, description, address) {
  const href = explorerLink(net, address);
  return h('div.dc-contract', h('div.dc-contract-top', h('strong', net.name), h('span.dc-chip', role), href ? h('a.round-button', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${net.name} ${role} in the explorer` }, icon('arrow-up-right', 'icon-sm')) : null),
    h('p', description), h('div.dc-addr', h('code', address), copyButton(address, '')));
}
function contracts(ctx) {
  const cards = [];
  for (const net of ctx.networks()) {
    if (net.kind === 'solana') {
      const program = net.shared?.programId ?? (ctx.solWallet?.net?.key === net.key ? ctx.solWallet.deployment?.programId : null);
      if (program) cards.push(contractCard(net, 'Program', 'The launchpad program. Curves, fees and locked liquidity live here.', program));
      continue;
    }
    // Mainnets (and V2 testnets): the V2 launchpad from its deployment record (24 November 2026: the page showed none).
    const v2 = net.v2?.shared;
    if (v2?.factory) {
      cards.push(contractCard(net, 'Factory', 'Creates every token, its Uniswap v4 pool and its metadata in one transaction.', v2.factory));
      if (v2.hook) cards.push(contractCard(net, 'Hook', 'The Uniswap v4 hook on every pool: takes each trade\u2019s fee, holds the locked liquidity and records graduation.', v2.hook));
      if (v2.router) cards.push(contractCard(net, 'Router', 'Buys and sells through the pool from the Elpida site.', v2.router));
      if (v2.usdcAirdrop) cards.push(contractCard(net, 'Trader airdrop', `Pays the traders\u2019 monthly airdrop in ${net.payoutStable?.symbol ?? 'USDC'}.`, v2.usdcAirdrop));
      if (v2.treasury) cards.push(contractCard(net, 'Treasury', 'The Elpida treasury, a multi-signature Safe. It receives Elpida\u2019s share of fees.', v2.treasury));
      continue;
    }
    if (net.shared?.factory) cards.push(contractCard(net, 'Factory', `Creates new tokens and their bonding curves (${net.shared.model}). Current launchpad on this network.`, net.shared.factory));
    for (const old of net.legacy ?? []) cards.push(contractCard(net, 'Legacy factory', `Earlier launchpad (${old.model}). Its tokens stay listed and tradable; no new launches.`, old.factory));
  }
  return cards.length ? h('div.dc-contracts', cards) : h('p.muted', 'No shared contract addresses are published for the networks you can see. Each browser sets up its own launchpad on those networks.');
}
// Developers (26 November 2026): for bots, terminals, trackers and scanners building on Elpida. The API answers at
// /api/v1 on this site (apps/api/public-api-v1.mjs); the ABIs come from the same list the API serves.
const API = [
  ['/api/v1/chains', 'Every chain with its contract addresses and fee split.'],
  ['/api/v1/tokens', 'Launches, newest first: identity, creator, image and links, pool. ?chain= &since= &limit= (≤ 500).'],
  ['/api/v1/tokens/{chain}/{address}', 'One launch.'],
  ['/api/v1/tokens/{chain}/{address}/trades', 'Latest trades. ?limit='],
  ['/api/v1/tokens/{chain}/{address}/candles', 'Price candles. ?interval= 60, 300, 900, 3600, 14400 or 86400 seconds.'],
  ['/api/v1/tokens/{chain}/{address}/holders', 'Largest holders.'],
  ['/api/v1/rewards', 'The monthly trader airdrop. ?wallet= for one wallet\u2019s standing.'],
  ['/api/v1/abi', 'Factory, router, hook and token ABIs as JSON. /api/v1/abi/{name} for one.'],
];
const EVENTS = [
  ['Factory · Launched', 'A new token: creator, token, quote asset, fee, first buy.'],
  ['Factory · MetadataPublished', 'The token\u2019s metadata link (ipfs://…): name, image, description and socials. Also readable with tokenMetadataURI(token).'],
  ['Router · Swapped', 'Every buy and sell through the Elpida router, with the real trader and both amounts.'],
  ['Hook · Fee', 'The fee each trade paid into the pool. Liquidity is held by the hook from the first trade: there are no LP tokens.'],
];
const BUY_EXAMPLE = `import { Contract, parseEther } from 'ethers';
const router = new Contract(ROUTER, [
  'function quote(address token,bool isBuy,uint256 amountIn) returns(uint256 paid,uint256 out)',
  'function buy(address token,uint256 quoteIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns(uint256)',
], signer);
const amount = parseEther('0.01');                      // a native-coin pair: ETH or BNB
const [, out] = await router.quote.staticCall(TOKEN, true, amount);
const deadline = Math.floor(Date.now() / 1000) + 300;
await router.buy(TOKEN, amount, out * 98n / 100n, await signer.getAddress(), deadline, { value: amount });
// Selling: approve the router for the tokens, then router.sell(TOKEN, tokensIn, minQuoteOut, recipient, deadline).
// USDC and stock pairs: approve the router for the quote asset and send no value.`;
function developers(origin) {
  const api = `${origin}/api/v1`;
  return [
    h('p', 'Build bots, terminals, trackers and scanners on Elpida. Every token trades in its own Uniswap v4 pool. Use the Elpida router below or open each contract in its explorer from the Contracts section.'),
    h('div.dc-options',
      tile('Contracts', 'Addresses for every chain are in Contracts above, and in /api/v1/chains.'),
      tile('Public API', `Read-only JSON at ${api}, open to any site, ${'up to 120 requests a minute per client'}.`),
      tile('ABIs', 'Factory, router, hook and token interfaces at /api/v1/abi.')),
    h('h3', 'API endpoints'),
    h('dl.dc-api', ...API.flatMap(([route, text]) => [h('dt', h('code', 'GET ' + route)), h('dd', text)])),
    h('p', h('a', { href: api, target: '_blank', rel: 'noopener noreferrer' }, 'Open the API index'), ' · ', h('a', { href: `${api}/abi`, target: '_blank', rel: 'noopener noreferrer' }, 'Download the ABIs')),
    h('h3', 'Trade through the router'),
    h('pre.dc-code', h('code', BUY_EXAMPLE)),
    h('h3', 'Events to index'),
    h('dl.dc-api', ...EVENTS.flatMap(([name, text]) => [h('dt', h('code', name)), h('dd', text)])),
    note('info', 'info', 'The /api/v1 endpoints stay stable: new fields and endpoints may be added, nothing is renamed or removed. Other /api paths on this site are internal and can change without notice.'),
  ];
}
const FAQ = (mainnet, mainnetNames) => [
  ['Can I change a token’s name, symbol or image after launch?', 'No. Name, symbol, image and links are recorded in the launch transaction and cannot be edited.'],
  ['Do I have to buy my own token?', `No. A creator purchase is optional. If you buy, it is part of the launch transaction, pays the token’s own fee and can receive at most ${pct(V2.firstBuyCapBps)} of the supply; the token page shows how much the creator bought and still holds. Launch fees and network costs apply either way.`],
  ['What is the launch fee?', 'A $10 fee, converted to the network’s native coin by a verified on-chain price feed at execution, or paid as 10 USDC where supported.'],
  ['Can a token’s fee change later?', 'No. The creator picks it once at launch and no one, including Elpida, can change it.'],
  ['Where can I inspect the contracts?', 'The Elpida contracts are open source. The Contracts section links to each explorer, where you can check the deployed address and source verification status.'],
  ...(mainnet ? [
    ['Do fees continue after graduation?', 'Yes. Graduation happens inside the same Uniswap v4 pool, so every trade keeps paying the token\u2019s fee, shared the same way, for good. There is no migration to another pool.'],
    ['Is Elpida live with real money?', `Yes. Transactions use real funds on ${mainnetNames}. Only trade what you can afford to lose.`],
  ] : [['Can I trade on mainnet?', 'Not on this site. Elpida here runs on public test networks, where tokens have no monetary value.']]),
];

export function renderDocs(ctx, section) {
  const mainnets = (ctx.networks?.() ?? []).filter(network => network.mainnet);
  const mainnet = !!ctx.config?.solana?.mainnet || mainnets.length > 0;
  const mainnetNames = new Intl.ListFormat('en').format(mainnets.map(network => network.name)) || 'enabled mainnet networks';
  const links = SECTIONS.map(([key, label, glyph]) => h('a.dc-toc-link', { href: `#/docs/${key}`, 'data-key': key }, icon(glyph, 'icon-sm'), label));
  const side = h('aside.dc-side', h('p.dc-eyebrow', '◆ ', ctx.envLabel?.() ?? 'Elpida'),
    h('h1', 'A little guidance. A whole new token.'),
    h('p.muted', 'How launching, trading and graduating work on Elpida, in plain language.'),
    h('div.dc-side-actions', h('a.btn.btn-primary', { href: '#/launch' }, 'Create a token', icon('arrow-right', 'icon-sm')), h('a.btn.btn-secondary', { href: '#/docs/contracts' }, 'Contract addresses')),
    h('nav.dc-toc', { 'aria-label': 'Docs sections' }, h('p.dc-eyebrow', icon('book-open', 'icon-sm'), 'Elpida docs'), ...links));

  const body = h('div.dc-body',
    card(0, SECTIONS[0],
      h('div.dc-tiles', disclaimerPoints({ mainnet }).map(p => tile(p.title, p.text))),
      ...fullDisclaimer({ mainnet }).map(text => h('p', text)),
      note('warn', 'triangle-alert', h('strong', 'Nothing on Elpida is financial advice. '), 'You are responsible for your own decisions and for checking every transaction your wallet asks you to confirm.'),
      h('p', 'Using Elpida means agreeing to the ', h('a', { href: '#/terms' }, 'Terms of Use'), '.')),
    card(1, SECTIONS[1],
      h('div.dc-steps', ...[['Connect and choose a chain', 'Connect a wallet and pick the network, on the create page or from the selector at the top.'], ['Describe the token', 'Name, symbol, image and optional links. These are fixed at launch.'], ['Pick a pair and rewards', 'Choose what buyers pay with and where the creator share of fees goes.'], ['Launch, optionally buying first', 'Pay the $10 launch fee. A creator purchase is optional: if you buy, it happens in the same transaction; zero means no tokens, no trade and no trading fee. No liquidity deposit.']].map(([t, d], i) => h('div.dc-step', h('span.dc-dot', String(i + 1)), h('div', h('strong', t), h('p', d))))),
      h('div.dc-stats', tile('1,000,000,000', 'Fixed supply of every token.'), tile(`${pct(V2_PROPOSED_MIN_FEE_BPS)}–${pct(V2.maxFeeBps)}`, 'Trading fee you pick once, at launch.'), tile('Locked from launch', 'Liquidity cannot be added to or withdrawn by anyone.'))),
    card(2, SECTIONS[2],
      h('div.dc-options', tile('Native coin', mainnet ? 'Buyers pay with the network’s coin: ETH or BNB.' : 'Buyers pay with the network’s coin, such as ETH or SOL.'),
        tile('USDC', mainnet ? 'A dollar pair: USDC, or USDG on Robinhood Chain.' : 'A dollar-priced pair on networks where USDC is enabled.'),
        tile('Tokenized stocks', mainnet ? 'Approved stocks, each priced by a Chainlink feed: Coinbase-issued stocks on Base, Ondo stocks on BNB Chain and Ethereum, Robinhood stock tokens on Robinhood Chain.' : 'Test assets on public testnets only. Unavailable on Solana.')),
      mainnet ? note('warn', 'triangle-alert', 'Tokenized stocks are issued by third parties; Elpida is not affiliated with any issuer. An issuer can pause or block its token. Stock pairs are not available to US persons (', h('a', { href: '#/terms' }, 'Terms'), ').') : null),
    card(3, SECTIONS[3],
      h('p', `Every token starts at a ${usd(V2.startFdvUsdE6)} market cap and its price follows one fixed curve to ${usd(V2.graduationFdvUsdE6)}, where it graduates (${V2.graduationFdvUsdE6 / V2.startFdvUsdE6}×).${mainnet ? '' : ' On test networks the sizes are scaled down with the same shape.'}`),
      h('p', `${mainnet ? 'Every' : 'On EVM networks the'} token trades in its own Uniswap v4 pool from the first trade. The liquidity is locked from launch: nobody, including Elpida, can add to it or remove it. Graduation happens in that same pool, with no migration, and the token keeps paying its fee after it. Before graduation the price cannot be sold below where it started.`),
      mainnet ? null : h('p', 'On Solana a token trades on its curve until graduation, then moves to a locked pool: Raydium CPMM for SOL pairs (its own 1% fee tier applies there), PumpSwap for other pairs.'),
      h('p', `Launch protection: for the first ${SNIPE_WINDOW_SECONDS} seconds the fee starts at ${pct(SNIPE_START_BPS)} and falls in a straight line to the token’s own fee. Anything above that fee is added to the token’s locked liquidity and never paid out.`),
      note('info', 'shield-check', 'Your wallet confirms every approval and transaction. Elpida never holds your keys or funds.')),
    card(4, SECTIONS[4],
      h('p', `The creator picks the token’s fee at launch, from ${pct(V2_PROPOSED_MIN_FEE_BPS)} to ${pct(V2.maxFeeBps)} (${pct(V2.defaultFeeBps)} by default). It never changes, before or after graduation. Every fee is shared three ways:`),
      h('div.dc-options',
        tile(`${pct(V23_FEE_SPLIT.traderAirdrop)} traders`, 'A monthly airdrop in USDC to every qualifying trader, by score: fees paid count with diminishing returns (fees^0.8), and trading on more days counts more, up to 12.'),
        tile(`${pct(V23_FEE_SPLIT.creator)} creator`, 'To the creator’s rewards: their wallet, other verified wallets, X accounts, websites or GitHub accounts and repositories, as chosen at launch.'),
        tile(`${pct(V23_FEE_SPLIT.treasury)} Elpida`, 'Platform revenue, to the Elpida treasury.')),
      h('p.small.muted', mainnet ? 'The traders’ airdrop is paid in USDC (USDG on Robinhood Chain).' : 'Where a reward is paid out, it is paid in USDC (a labelled test dollar on some test networks). Older test tokens launched before V2 keep the rules they launched with.')),
    card(5, SECTIONS[5], h('p.muted', 'Generated from the network registry. Always compare an address with the explorer before interacting.'), contracts(ctx)),
    card(6, SECTIONS[6], ...developers(location.origin)),
    card(7, SECTIONS[7], h('div.dc-faq', ...FAQ(mainnet, mainnetNames).map(([q, a]) => h('details.dc-q', h('summary', q, icon('chevron-down', 'icon-sm')), h('p', a))))),
    card(8, SECTIONS[8],
      h('p', 'Elpida keeps as little about you as it can. It has no accounts, no advertising and no third-party trackers.'),
      h('div.dc-options',
        tile('Essential storage', 'Your browser remembers your network, theme, wallet choice, the disclaimer and your cookie choice. A short-lived cookie protects token uploads, and operators get a sign-in cookie. Always on.'),
        tile('Analytics, only if you allow it', 'Which pages are visited, the token and network viewed, where the visit came from, the country and the device type (phone, tablet or computer), linked by a random id kept in your browser. Stored for 90 days.'),
        tile('Never collected', 'Elpida does not store your IP address, wallet address, browser details or search text with analytics. Our hosting and network providers see IP addresses to deliver the site. Nothing is sold or shared with advertisers.'),
        tile('Public by nature', 'Transactions you make are public on the blockchain. Elpida reads and shows that public data, as any explorer does.')),
      h('p', 'Turning analytics off deletes the random id from your browser. After that only your choice itself is counted, with no id. Clearing your site data also removes the id and brings back the disclaimer and the cookie banner.'),
      h('p', h('button.btn.btn-secondary', { type: 'button', 'data-cookie-settings': '' }, icon('sliders-horizontal', 'icon-sm'), 'Cookie settings'))),
    h('section.dc-cta', h('div', h('strong', 'Your idea is next.'), h('p.muted', mainnet ? `Launch in one transaction on ${mainnetNames}.` : 'Launch on a test network first and see every step.')), h('a.btn.btn-primary', { href: '#/launch' }, 'Create a token', icon('arrow-right', 'icon-sm'))));

  const root = h('div.dc', side, body);
  const setActive = key => links.forEach(a => a.classList.toggle('is-active', a.dataset.key === key));
  setActive(section ?? SECTIONS[0][0]);
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(entries => { const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) setActive(top.target.dataset.section); }, { rootMargin: '-15% 0px -70% 0px' });
    queueMicrotask(() => { if (!root.isConnected) return; body.querySelectorAll('[data-section]').forEach(el => observer.observe(el)); });
    new MutationObserver((_, self) => { if (!root.isConnected) { observer.disconnect(); self.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
  }
  if (section) requestAnimationFrame(() => document.getElementById(`doc-${section}`)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  return root;
}
