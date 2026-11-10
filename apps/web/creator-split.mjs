// V2 creator splits on the token page: when a V2 token's creator share goes to a split contract (chosen at launch, up
// to 8 wallets, no owner), this card lists each wallet, its fixed share and what it can claim, with a button that
// collects the token's fees from the pool and pays that wallet. Anyone may press it; the money only goes to the wallet.
import { JsonRpcProvider, formatUnits } from '/vendor/ethers.js';
import { h, short, number, errorText } from './ui.mjs';
import { creatorSplitState, creatorStrategyState } from './v2-launchpad.mjs';

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
        h('dt', 'Threshold'), h('dd', `${fmt(s.threshold)} ${symbol}`),
        h('dt', 'Gathered'), h('dd', `${fmt(s.gathered)} ${symbol}`),
        h('dt', 'Minimum holding'), h('dd', `${number(Number(formatUnits(s.minimumHolding, 18)), 2)} ${token.symbol}`),
        ...(s.mode === 'paired' ? [h('dt', 'Paid in'), h('dd', assetLabel(s.rewardAsset))] : []),
        ...(s.mode === 'buyback' ? [h('dt', 'Vesting'), h('dd', `${number(s.vesting / 86400, 2)} days`)] : []),
        h('dt', 'Rounds paid'), h('dd', String(s.roundCount))),
      s.rounds.length ? h('ul.split-list', s.rounds.map(r => h('li', h('span', `Round ${r.round + 1} · ${r.recipients} holders`), h('span.split-share', `${fmt(r.total, r.asset.toLowerCase() === token.address.toLowerCase() ? 18 : decimals)} ${assetLabel(r.asset)}`),
        h('span.split-amount', r.vesting ? `${number(Number(r.claimed * 10000n / (r.total || 1n)) / 100, 2)}% vested and paid` : 'Paid'), h('span')))) : null,
      h('p.small.muted', 'Fixed at launch in vault ', h('span.mono', short(s.vault)), '. When the threshold is reached, the Elpida keeper pays holders by their balance at that moment (pools and Elpida contracts excluded). Test networks only; not audited.'));
  })();
  return card;
}
