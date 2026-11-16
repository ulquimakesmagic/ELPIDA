// Solana creator vaults on the token page (16 November 2026): what the token's creator chose for their 30% at launch.
//  - Allocations: each row's share and what it is owed. A wallet row (or a verified X account or website) is paid with
//    "Collect and pay out" (anyone may press it; the money only goes to that wallet). An unverified X or website row
//    shows "Verify ownership": the owner signs for a payout wallet with their Solana wallet, proves control (a DNS TXT
//    record or X sign-in), and the Elpida keeper binds that wallet, once.
//  - Share fees with holders / buy a reward token: the threshold, what has gathered and the latest rounds the keeper paid.
import { h, short, number, errorText, copyButton, icon } from './ui.mjs';
import { keepFresh } from './creator-split.mjs';

const MODE_NAMES = { allocation: 'Wallet, X and website allocations', holders: 'Share fees with holders', paired: 'Buy a reward token for holders' };

export function solanaCreatorVaultCard(ctx, token) {
  const network = token?.network ?? ctx.wallet?.net?.key;
  if (!String(network ?? '').startsWith('solana') || !token?.v2) return null;
  const decimals = Number(token.quoteDecimals ?? 9), symbol = token.quoteSymbol ?? 'SOL';
  const body = h('div.stack'), flow = h('div.stack'), error = h('p.error-text', { role: 'alert' }), title = h('h2.tk-h', icon('coins', 'icon-sm'), 'Creator rewards');
  const card = h('section.tk-card.tk-split.tk-alloc', { hidden: true, id: 'allocations', 'aria-label': 'Creator rewards' }, h('div.tk-alloc-head', title), body, flow, error);
  const connected = () => !!ctx.wallet?.address && String(ctx.wallet?.net?.key ?? '') === network;
  let decimals_ = decimals;
  const amountOf = (raw, d = decimals_) => Number(BigInt(raw ?? 0)) / 10 ** d;
  // Dollar values at the pair asset's current reference price (test networks: labelled test values), then the asset.
  const usd = () => Number(token.usdReference?.usd ?? 0);
  const fmt = (raw, d = decimals_) => number(amountOf(raw, d), 6);
  const value = (raw, d = decimals_) => usd() > 0 ? `$${number(amountOf(raw, d) * usd(), 2)}` : `${fmt(raw, d)} ${symbol}`;
  const both = (raw, d = decimals_) => usd() > 0 ? [h('strong', value(raw, d)), h('small.muted', ` · ${fmt(raw, d)} ${symbol}`)] : [h('strong', value(raw, d))];
  let busy = false;
  const act = async fn => { if (busy) return; busy = true; error.textContent = ''; try { await fn(); } catch (e) { error.textContent = errorText(e); } finally { busy = false; } };
  const name = r => (r.kind === 'x' ? `@${r.target}` : r.kind === 'domain' ? r.target : short(r.wallet));

  function verify(r) {
    flow.replaceChildren(h('p.small.muted', 'Getting a verification request…'));
    act(async () => {
      if (!connected()) throw new Error('Connect the Solana wallet that should receive this share.');
      const c = await ctx.api('v2-identity/challenge', { network, vault: token.address, index: r.index, wallet: ctx.wallet.address, token: token.address });
      const sign = () => ctx.wallet.signText(c.message);
      if (c.kind === 'domain') {
        flow.replaceChildren(h('p.small', `Add this TXT record to ${c.target}'s DNS, then check it. It proves you control the website; the share will pay ${short(ctx.wallet.address)}.`),
          h('dl.kv', h('dt', 'Name'), h('dd', h('span.mono', c.name), ' ', copyButton(c.name, 'Copy')), h('dt', 'Value'), h('dd', h('span.mono', c.txt), ' ', copyButton(c.txt, 'Copy'))),
          h('button.btn.btn-primary.btn-sm', { type: 'button', on: { click: () => act(async () => { const r2 = await ctx.api('v2-identity/verify-domain', { nonce: c.nonce, signature: await sign() }); flow.replaceChildren(h('p.small', r2.message)); await load(); }) } }, 'Sign and check DNS'));
      } else {
        flow.replaceChildren(h('p.small', `Sign for ${short(ctx.wallet.address)} as the payout wallet, then sign in to X as @${c.target}.`),
          h('button.btn.btn-primary.btn-sm', { type: 'button', on: { click: () => act(async () => { const r2 = await ctx.api('v2-identity/x-start', { nonce: c.nonce, signature: await sign() }); location.assign(r2.url); }) } }, 'Sign and continue to X'));
      }
    }).then(() => { if (error.textContent) flow.replaceChildren(); });
  }

  async function load({ quiet = false } = {}) {
    if (quiet && (busy || flow.childElementCount)) return;
    let s;
    try { s = await ctx.api(`public/solana-creator-vault/${token.address}`); } catch { if (!quiet) card.hidden = true; return; }
    if (s?.quoteDecimals != null) decimals_ = Number(s.quoteDecimals);
    if (!s?.vault && !s?.creatorWallet) { card.hidden = true; return; }
    card.hidden = false;
    if (!s.vault) {
      // One creator wallet: the whole 30%, collected into that wallet by anyone.
      title.replaceChildren(icon('coins', 'icon-sm'), 'Allocations');
      body.replaceChildren(
        h('p.small.muted', 'The creator\'s 30% share of every fee goes to this wallet. Anyone can collect it; it is only ever paid to this wallet.'),
        h('ul.split-list', h('li',
          h('span', { title: s.creatorWallet }, short(s.creatorWallet), h('span.verified-tick', { title: 'Wallet fixed at launch', 'aria-label': 'Verified' }, icon('badge-check', 'icon-xs'))),
          h('span.split-share', '100%'),
          h('span.split-amount', ...both(s.pending), h('small.muted', ` · paid ${value(s.paid)}`)),
          h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: !connected() || BigInt(s.pending ?? 0) === 0n, title: connected() ? undefined : 'Connect a Solana wallet to pay out.', on: { click: () => act(async () => { await ctx.run('withdraw', { token: token.address }); await load(); }) } }, 'Collect and pay out'))),
        h('p.small.muted', 'Updated with every trade. Test network; not audited.'));
      return;
    }
    if (s.mode === 'allocation') {
      title.replaceChildren(icon('coins', 'icon-sm'), 'Allocations');
      body.replaceChildren(
        h('p.small.muted', 'The creator\'s 30% share is split between these recipients, fixed for good in vault ', h('span.mono', short(s.vault)), '. X and website shares are held until their owners verify.'),
        h('ul.split-list', s.rows.map(r => h('li',
          h('span', { title: r.wallet ?? '' }, name(r), r.wallet ? h('span.verified-tick', { title: r.kind === 'wallet' ? 'Wallet fixed at launch' : `Verified: pays ${r.wallet}`, 'aria-label': 'Verified' }, icon('badge-check', 'icon-xs')) : null,
            r.kind !== 'wallet' ? h('small.muted', r.wallet ? ` · pays ${short(r.wallet)}` : ' · not verified') : null),
          h('span.split-share', `${number(r.bps / 100, 2)}%`),
          h('span.split-amount', ...both(r.due), h('small.muted', ` · paid ${value(r.claimed)}`)),
          r.wallet ? h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: !connected(), title: connected() ? undefined : 'Connect a Solana wallet to pay out.', on: { click: () => act(async () => { await ctx.run('creator-row-claim', { token: token.address, row: r.index }); await load(); }) } }, 'Collect and pay out')
            : h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: r.kind === 'x' && !ctx.config?.v2Identities?.x, title: r.kind === 'x' && !ctx.config?.v2Identities?.x ? 'X sign-in is not set up on this server yet.' : undefined, on: { click: () => verify(r) } }, 'Verify ownership')))),
        h('p.small.muted', 'What each recipient is owed, updated with every trade (including fees the pool still holds for the creator, which "Collect and pay out" collects first). Test network; not audited.'));
      return;
    }
    title.replaceChildren(icon('users', 'icon-sm'), 'Creator rewards');
    const payoutSymbol = s.payoutMint === s.quoteMint ? symbol : s.payoutMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : short(s.payoutMint);
    body.replaceChildren(
      h('dl.kv', h('dt', 'Strategy'), h('dd', MODE_NAMES[s.mode] ?? s.mode),
        h('dt', 'Threshold'), h('dd', s.thresholdUsd ? `$${number(s.thresholdUsd, 2)} at launch (${fmt(s.threshold)} ${symbol})` : `${fmt(s.threshold)} ${symbol}`),
        h('dt', 'Gathered'), h('dd', ...both(BigInt(s.held) + BigInt(s.pending ?? 0))),
        h('dt', 'Minimum holding'), h('dd', `${number(Number(BigInt(s.minimumHolding)) / 1e6, 2)} ${token.symbol}${s.minimumHoldingUsd ? ` and $${number(s.minimumHoldingUsd, 2)}` : ''}`),
        ...(s.mode === 'paired' ? [h('dt', 'Paid in'), h('dd', payoutSymbol)] : []),
        h('dt', 'Rounds paid'), h('dd', String(s.roundCount))),
      s.rounds.length ? h('ul.split-list', s.rounds.map(r => h('li', h('span', `Round ${r.round + 1} · ${r.recipients} holders`), h('span.split-share', `${fmt(r.total, s.mode === 'paired' && payoutSymbol === 'SOL' ? 9 : decimals)} ${payoutSymbol}`), h('span.split-amount', BigInt(r.claimed) >= BigInt(r.total) ? 'Paid' : `${number(Number(BigInt(r.claimed) * 10000n / (BigInt(r.total) || 1n)) / 100, 2)}% paid`), h('span')))) : null,
      h('p.small.muted', 'Fixed at launch in vault ', h('span.mono', short(s.vault)), '. When the threshold is reached, the Elpida keeper pays holders by their balance at that moment (pools and Elpida accounts excluded). Test network; not audited.'));
  }
  load().then(() => { if (!card.hidden) keepFresh(card, load); });
  return card;
}

/**
 * The "Claim fees · $X" tag beside a Solana V2 token's name: what the creator's recipients are owed now (the vault's
 * rows, or the creator wallet's uncollected 30%), linking to the Allocations card. Refreshed with every trade.
 */
export function solanaClaimTag(ctx, token) {
  if (!token?.solanaV2) return null;
  const amount = h('span.tk-tag-amount', '…');
  const tag = h('a.tk-tag.tk-tag-claim', { href: `#/token/${token.address}`, hidden: true, on: { click: e => { e.preventDefault(); document.getElementById('allocations')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } } }, icon('coins', 'icon-xs'), h('span', 'Claim fees ·'), amount);
  async function load() {
    try {
      const s = await ctx.api(`public/solana-creator-vault/${token.address}`);
      const d = Number(s?.quoteDecimals ?? token.quoteDecimals ?? 9), raw = s?.vault ? s.rows.reduce((t, r) => t + BigInt(r.due ?? 0), 0n) : BigInt(s?.pending ?? 0);
      if (!s?.vault && !s?.creatorWallet) { tag.hidden = true; return; }
      const units = Number(raw) / 10 ** d, usd = Number(token.usdReference?.usd ?? 0);
      amount.textContent = usd > 0 ? `$${number(units * usd, 2)}` : `${number(units, 6)} ${token.quoteSymbol ?? ''}`;
      tag.title = 'What the creator\'s recipients can collect now. Open the Allocations card to pay out.';
      tag.hidden = false;
    } catch { /* keep the last value */ }
  }
  load().then(() => keepFresh(tag, load));
  return tag;
}
