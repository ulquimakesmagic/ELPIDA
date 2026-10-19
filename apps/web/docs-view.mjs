// Docs (#/docs): guidance in plain language. Figures come from packages/core/curve-model.mjs and the network
// registry, so this page cannot drift from the contracts. Nothing here promises mainnet availability.
import { h, icon, copyButton, short } from './ui.mjs';
import { BASE_FEE_BPS, SNIPE_START_BPS, SNIPE_WINDOW_SECONDS, GRADUATION_GRACE_SECONDS, END_MULTIPLE, TESTNET_START_FDV_USD } from '/curve-model.mjs';

const SECTIONS = [
  ['risk', 'Risk disclaimer', 'triangle-alert'],
  ['create-your-token', 'Create your token', 'plus'],
  ['choose-your-pair', 'Choose your pair', 'layers'],
  ['trade-and-graduate', 'Trade and graduate', 'trending-up'],
  ['fees-and-rewards', 'Fees and rewards', 'coins'],
  ['contracts', 'Contracts', 'file-text'],
  ['faq', 'FAQ', 'circle-help'],
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
    if (net.shared?.factory) cards.push(contractCard(net, 'Factory', `Creates new tokens and their bonding curves (${net.shared.model}). Current launchpad on this network.`, net.shared.factory));
    for (const old of net.legacy ?? []) cards.push(contractCard(net, 'Legacy factory', `Earlier launchpad (${old.model}). Its tokens stay listed and tradable; no new launches.`, old.factory));
  }
  return cards.length ? h('div.dc-contracts', cards) : h('p.muted', 'No shared contract addresses are published for the networks you can see. Each browser sets up its own launchpad on those networks.');
}
const FAQ = [
  ['Can I change a token’s name, symbol or image after launch?', 'No. Name, symbol, image and links are recorded in the launch transaction and cannot be edited.'],
  ['Why does my first purchase happen at launch?', `Your token launches with the creator’s first purchase in the same transaction, paying only the base ${pct(BASE_FEE_BPS)} fee. There is no cap on that purchase, and the token page shows how much the creator bought and still holds.`],
  ['What is the launch fee?', 'A $10 fee, converted to the network’s native coin by a verified on-chain price feed at execution, or paid as 10 USDC where supported.'],
  ['What happens if graduation fails?', `If a completed curve has not graduated ${GRADUATION_GRACE_SECONDS / 3600} hours after it completed, anyone can reopen it so every holder can trade again.`],
  ['Are the contracts audited?', 'Not yet. They have not had an independent audit. Treat everything as experimental.'],
  ['Can I trade on mainnet?', 'Elpida runs on a local simulation and public test networks, where tokens have no monetary value. Solana runs as an invite-only beta with unaudited contracts and real funds.'],
];

export function renderDocs(ctx, section) {
  const links = SECTIONS.map(([key, label, glyph]) => h('a.dc-toc-link', { href: `#/docs/${key}`, 'data-key': key }, icon(glyph, 'icon-sm'), label));
  const side = h('aside.dc-side', h('p.dc-eyebrow', '◆ ', ctx.envLabel?.() ?? 'Elpida'),
    h('h1', 'A little guidance. A whole new token.'),
    h('p.muted', 'How launching, trading and graduating work on Elpida, in plain language.'),
    h('div.dc-side-actions', h('a.btn.btn-primary', { href: '#/launch' }, 'Create a token', icon('arrow-right', 'icon-sm')), h('a.btn.btn-secondary', { href: '#/docs/contracts' }, 'Contract addresses')),
    h('nav.dc-toc', { 'aria-label': 'Docs sections' }, h('p.dc-eyebrow', icon('book-open', 'icon-sm'), 'Elpida docs'), ...links));

  const body = h('div.dc-body',
    card(0, SECTIONS[0],
      h('div.dc-tiles', tile('Tokens can lose all value', 'New tokens are volatile and many go to zero. Only use funds you can afford to lose.'), tile('Experimental software', 'The contracts have not had an independent audit and bugs are possible.'), tile('Test networks', 'Most networks here are test networks. Test tokens have no monetary value.')),
      note('warn', 'triangle-alert', h('strong', 'Nothing on Elpida is financial advice. '), 'You are responsible for your own decisions and for checking every transaction your wallet asks you to confirm.')),
    card(1, SECTIONS[1],
      h('div.dc-steps', ...[['Connect and choose a chain', 'Connect a wallet and pick the network from the selector at the top.'], ['Describe the token', 'Name, symbol, image and optional links. These are fixed at launch.'], ['Pick a pair and rewards', 'Choose what buyers pay with and where the creator share of fees goes.'], ['Launch with a first purchase', 'Pay the $10 launch fee and make the first purchase in one transaction. No liquidity deposit.']].map(([t, d], i) => h('div.dc-step', h('span.dc-dot', String(i + 1)), h('div', h('strong', t), h('p', d))))),
      h('div.dc-stats', tile('1,000,000,000', 'Fixed supply of every token.'), tile(pct(BASE_FEE_BPS), 'Trade fee on the curve.'), tile('Locked forever', 'Liquidity at graduation cannot be withdrawn.'))),
    card(2, SECTIONS[2],
      h('div.dc-options', tile('Native coin', 'Buyers pay with the network’s coin, such as ETH or SOL.'), tile('USDC', 'A dollar-priced pair on networks where USDC is enabled.'), tile('Tokenized stocks', 'Test assets on public testnets only. Unavailable on Solana.'), tile('Elpida tokens', 'A graduated Elpida token can be the pair for a new launch.')),
      note('warn', 'triangle-alert', 'Tokens with a transfer fee or an issuer permanent delegate cannot be used as a trading pair.')),
    card(3, SECTIONS[3],
      h('p', `The price comes from a virtual bonding curve, not a funded pool. Purchases build a trading reserve and sales are paid from it. The curve is built to rise ${END_MULTIPLE}x from start to graduation; on test networks a token starts at about $${TESTNET_START_FDV_USD} market cap.`),
      h('p', `Launch protection: for the first ${SNIPE_WINDOW_SECONDS} seconds the fee starts at ${pct(SNIPE_START_BPS)} and falls in a straight line to ${pct(BASE_FEE_BPS)}. Anything above ${pct(BASE_FEE_BPS)} is added to the token’s locked liquidity. The creator’s own first purchase pays only the base fee.`),
      h('p', 'When the curve sells out, its reserve and the remaining tokens open a DEX pool at the final curve price: Uniswap v3 on Base Sepolia, PumpSwap on Solana, a locked test pool on other test networks. That liquidity is locked permanently.'),
      h('p', `If graduation has not happened ${GRADUATION_GRACE_SECONDS / 3600} hours after the curve completed, anyone can reopen it for trading.`),
      note('info', 'shield-check', 'Your wallet confirms every approval and transaction. Elpida never holds your keys or funds.')),
    card(4, SECTIONS[4],
      h('p', `Each curve trade pays ${pct(BASE_FEE_BPS)}, split equally between Elpida and the creator. After graduation, the pool’s trading fees are also split 50/50.`),
      h('div.dc-options', tile('To the creator', 'Fees accumulate for the wallets the creator chooses; each wallet claims its share.'), tile('To holders', 'Fees are paid to eligible holders, weighted by holdings at a snapshot.'), tile('Reward asset', 'Fees buy a reward asset and distribute it to holders.'), tile('Buyback and vest', 'Fees buy back the token and vest it to holders.')),
      h('p.small.muted', 'The creator’s choice is fixed at launch. Some strategies are simulation-only or unavailable on a given network; the launch page shows what is live.')),
    card(5, SECTIONS[5], h('p.muted', 'Generated from the network registry. Always compare an address with the explorer before interacting.'), contracts(ctx)),
    card(6, SECTIONS[6], h('div.dc-faq', ...FAQ.map(([q, a]) => h('details.dc-q', h('summary', q, icon('chevron-down', 'icon-sm')), h('p', a))))),
    h('section.dc-cta', h('div', h('strong', 'Your idea is next.'), h('p.muted', 'Launch on a test network first and see every step.')), h('a.btn.btn-primary', { href: '#/launch' }, 'Create a token', icon('arrow-right', 'icon-sm'))));

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
