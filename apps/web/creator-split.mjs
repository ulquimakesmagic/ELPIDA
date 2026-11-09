// V2 creator splits on the token page: when a V2 token's creator share goes to a split contract (chosen at launch, up
// to 8 wallets, no owner), this card lists each wallet, its fixed share and what it can claim, with a button that
// collects the token's fees from the pool and pays that wallet. Anyone may press it; the money only goes to the wallet.
import { JsonRpcProvider, formatUnits } from '/vendor/ethers.js';
import { h, short, number, errorText } from './ui.mjs';
import { creatorSplitState } from './v2-launchpad.mjs';

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
