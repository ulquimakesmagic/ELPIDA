// V2 creator splits on the token page: when a V2 token's creator share goes to a split contract (chosen at launch, up
// to 8 wallets, no owner), this card lists each wallet, its fixed share and what it can claim, with a button that
// collects the token's fees from the pool and pays that wallet. Anyone may press it; the money only goes to the wallet.
import { JsonRpcProvider, formatUnits } from '/vendor/ethers.js';
import { h, short, number, errorText, copyButton } from './ui.mjs';
import { creatorSplitState, creatorStrategyState, identityAllocationState } from './v2-launchpad.mjs';

export function creatorSplitCard(ctx, token) {
  if (token?.deploymentModel !== 'v2-hook' || String(token.network ?? '').startsWith('solana')) return null;
  const net = (ctx.config?.testnets ?? []).find(n => n.key === token.network);
  if (!net) return null;
  const native = token.pair === 'native', decimals = native ? 18 : Number(token.quoteDecimals ?? 18), symbol = native ? net.nativeCurrency?.symbol ?? 'ETH' : token.quoteSymbol;
  const body = h('div.stack'), error = h('p.error-text', { role: 'alert' });
  const card = h('section.tk-card.tk-split', { hidden: true, 'aria-label': 'Creator split' }, h('h2.tk-h', 'Creator split'), body, error);
  const provider = () => (ctx.wallet?.net?.key === net.key && ctx.wallet?.provider ? ctx.wallet.provider : new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true }));
  let busy = false;
  async function load() {
    let state = null;
    try { state = await creatorSplitState({ provider: provider(), net, token: token.address }); } catch { state = null; }
    if (!state) { card.hidden = true; return; }
    card.hidden = false;
    body.replaceChildren(
      h('p.small.muted', `The creator's 30% share is split between these wallets, fixed for good by contract `, h('span.mono', short(state.vault)), '. Fees still in the pool are collected when a share is paid out.'),
      h('ul.split-list', state.rows.map(r => h('li',
        h('span.mono', { title: r.wallet }, short(r.wallet)), h('span.split-share', `${number(r.bps / 100, 2)}%`),
        h('span.split-amount', `${number(Number(formatUnits(r.claimable, decimals)), 6)} ${symbol}`),
        h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: ctx.mode !== 'testnet', title: ctx.mode !== 'testnet' ? 'Connect a wallet on this network to pay out.' : undefined, on: { click: async () => {
          if (busy) return; busy = true; error.textContent = '';
          try { await ctx.run('claim-creator-split', { token: token.address, wallet: r.wallet }); await load(); } catch (e) { error.textContent = errorText(e); } finally { busy = false; }
        } } }, 'Collect and pay out')))));
  }
  load();
  return card;
}

const STRATEGY_NAMES = { holders: 'Share fees with holders', paired: 'Buy a reward token for holders', buyback: 'Buy back and vest to holders' };
/** The token's holder strategy (chosen at launch), what has gathered toward its threshold and its latest rounds. */
export function creatorStrategyCard(ctx, token) {
  if (token?.deploymentModel !== 'v2-hook' || String(token.network ?? '').startsWith('solana')) return null;
  const net = (ctx.config?.testnets ?? []).find(n => n.key === token.network);
  if (!net) return null;
  const native = token.pair === 'native', decimals = native ? 18 : Number(token.quoteDecimals ?? 18), symbol = native ? net.nativeCurrency?.symbol ?? 'ETH' : token.quoteSymbol;
  const body = h('div.stack'), card = h('section.tk-card.tk-split', { hidden: true, 'aria-label': 'Creator rewards' }, h('h2.tk-h', 'Creator rewards'), body);
  const provider = () => (ctx.wallet?.net?.key === net.key && ctx.wallet?.provider ? ctx.wallet.provider : new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true }));
  (async () => {
    let s = null; try { s = await creatorStrategyState({ provider: provider(), net, token: token.address }); } catch { s = null; }
    if (!s) return;
    card.hidden = false;
    const fmt = (v, d = decimals) => number(Number(formatUnits(v, d)), 6);
    const assetLabel = a => (a === '0x0000000000000000000000000000000000000000' ? net.nativeCurrency?.symbol ?? 'ETH' : a.toLowerCase() === token.address.toLowerCase() ? token.symbol : short(a));
    body.replaceChildren(
      h('dl.kv', h('dt', 'Strategy'), h('dd', STRATEGY_NAMES[s.mode] ?? s.mode),
        h('dt', 'Threshold'), h('dd', s.thresholdUsd ? `$${number(s.thresholdUsd, 2)} at launch (${fmt(s.threshold)} ${symbol})` : `${fmt(s.threshold)} ${symbol}`),
        h('dt', 'Gathered'), h('dd', `${fmt(s.gathered)} ${symbol}`),
        h('dt', 'Minimum holding'), h('dd', s.minimumHoldingUsd ? `$${number(s.minimumHoldingUsd, 2)} of ${token.symbol} at the current price${s.minimumHolding > 0n ? ` and at least ${number(Number(formatUnits(s.minimumHolding, 18)), 2)}` : ''}` : `${number(Number(formatUnits(s.minimumHolding, 18)), 2)} ${token.symbol}`),
        ...(s.mode === 'paired' ? [h('dt', 'Paid in'), h('dd', assetLabel(s.rewardAsset))] : []),
        ...(s.mode === 'buyback' ? [h('dt', 'Vesting'), h('dd', `${number(s.vesting / 86400, 2)} days`)] : []),
        h('dt', 'Rounds paid'), h('dd', String(s.roundCount))),
      s.rounds.length ? h('ul.split-list', s.rounds.map(r => h('li', h('span', `Round ${r.round + 1} · ${r.recipients} holders`), h('span.split-share', `${fmt(r.total, r.asset.toLowerCase() === token.address.toLowerCase() ? 18 : decimals)} ${assetLabel(r.asset)}`),
        h('span.split-amount', r.vesting ? `${number(Number(r.claimed * 10000n / (r.total || 1n)) / 100, 2)}% vested and paid` : 'Paid'), h('span')))) : null,
      h('p.small.muted', 'Fixed at launch in vault ', h('span.mono', short(s.vault)), '. When the threshold is reached, the Elpida keeper pays holders by their balance at that moment (pools and Elpida contracts excluded). Test networks only; not audited.'));
  })();
  return card;
}

/**
 * Wallet, X and website allocations: each row's share and what it can claim. A wallet row (or a verified X account or
 * website) is paid with "Collect and pay out". An unverified X or website row shows "Verify ownership": the owner signs
 * for a payout wallet, then proves control (a DNS TXT record, or X sign-in), and the Elpida keeper binds that wallet.
 */
export function identityAllocationCard(ctx, token) {
  if (token?.deploymentModel !== 'v2-hook' || String(token.network ?? '').startsWith('solana')) return null;
  const net = (ctx.config?.testnets ?? []).find(n => n.key === token.network);
  if (!net) return null;
  const native = token.pair === 'native', decimals = native ? 18 : Number(token.quoteDecimals ?? 18), symbol = native ? net.nativeCurrency?.symbol ?? 'ETH' : token.quoteSymbol;
  const body = h('div.stack'), flow = h('div.stack'), error = h('p.error-text', { role: 'alert' });
  const card = h('section.tk-card.tk-split', { hidden: true, 'aria-label': 'Allocations' }, h('h2.tk-h', 'Allocations'), body, flow, error);
  const provider = () => (ctx.wallet?.net?.key === net.key && ctx.wallet?.provider ? ctx.wallet.provider : new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true }));
  const connected = () => ctx.mode === 'testnet' && ctx.wallet?.net?.key === net.key && !!ctx.wallet?.address;
  let busy = false, vault = null;
  const act = async fn => { if (busy) return; busy = true; error.textContent = ''; try { await fn(); } catch (e) { error.textContent = errorText(e); } finally { busy = false; } };
  const name = r => (r.kind === 'x' ? `@${r.target}` : r.kind === 'domain' ? r.target : short(r.wallet));
  function verify(r) {
    flow.replaceChildren(h('p.small.muted', 'Getting a verification request…'));
    act(async () => {
      if (!connected()) throw new Error(`Connect the wallet that should receive this share, on ${net.name}.`);
      const c = await ctx.api('v2-identity/challenge', { network: net.key, vault, index: r.index, wallet: ctx.wallet.address });
      const sign = async () => ctx.wallet.signer.signMessage(c.message);
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
  async function load() {
    let state = null;
    try { state = await identityAllocationState({ provider: provider(), net, token: token.address }); } catch { state = null; }
    if (!state) { card.hidden = true; return; }
    card.hidden = false; vault = state.vault;
    body.replaceChildren(
      h('p.small.muted', 'The creator\'s 30% share is split between these recipients, fixed for good by contract ', h('span.mono', short(state.vault)), '. X and website shares are held until their owners verify.'),
      h('ul.split-list', state.rows.map(r => h('li',
        h('span', { title: r.wallet ?? '' }, name(r), r.kind !== 'wallet' ? h('small.muted', r.wallet ? ` · pays ${short(r.wallet)}` : ' · not verified') : null),
        h('span.split-share', `${number(r.bps / 100, 2)}%`),
        h('span.split-amount', `${number(Number(formatUnits(r.claimable, decimals)), 6)} ${symbol}`),
        r.wallet ? h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: ctx.mode !== 'testnet', on: { click: () => act(async () => { await ctx.run('claim-identity-row', { token: token.address, index: r.index }); await load(); }) } }, 'Collect and pay out')
          : h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: r.kind === 'x' && !ctx.config?.v2Identities?.x, title: r.kind === 'x' && !ctx.config?.v2Identities?.x ? 'X sign-in is not set up on this server yet.' : undefined, on: { click: () => verify(r) } }, 'Verify ownership')))));
  }
  load();
  return card;
}
