// Swap (Malik, 20 November 2026): the network's native coin, USDC and tokenized stocks, both ways, on mainnet.
// Base swaps Coinbase stocks; other mainnets their Ondo stocks (config/stocks/<network>.json). The server asks KyberSwap
// for a route and the calldata (apps/api/swap.mjs); this page approves the exact input when needed and sends the swap
// from the visitor's own wallet, only ever to Kyber's router. Stocks follow the same region rule as stock pairs.
import { Contract, parseUnits, formatUnits } from '/vendor/ethers.js';
import { h, icon, callout, number, errorText, toast } from './ui.mjs';
import { stockPicker, loadStockCatalog } from './stock-picker.mjs';
import { stockRegionOff } from '/pairs.mjs';

export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ERC20 = ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
const SLIPPAGES = [50, 100, 200], PORTIONS = [25, 50, 100];
// Kept back from a 100% native-coin swap so the wallet can still pay gas.
const GAS_RESERVE = { 'base-mainnet': 200_000_000_000_000n, 'bnb-mainnet': 1_000_000_000_000_000n, 'ethereum-mainnet': 3_000_000_000_000_000n };

/** A share (percent) of a balance in base units; native coin keeps a gas reserve at 100%. */
export function portionOf(balance, pct, { native = false, reserve = 0n } = {}) {
  const b = BigInt(balance ?? 0); if (b <= 0n) return 0n;
  const part = b * BigInt(pct) / 100n;
  if (!native) return part;
  const cap = b > reserve ? b - reserve : 0n;
  return part > cap ? cap : part;
}
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Human amount → base units, or null when it is not a positive number with at most `decimals` places. */
export function toUnits(text, decimals) {
  const s = String(text ?? '').trim();
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.$/.test(s)) return null;
  try { const v = parseUnits(s.replace(/\.$/, ''), decimals); return v > 0n ? v : null; } catch { return null; }
}

export function renderSwap(ctx) {
  const root = h('section.swap-page', { 'aria-label': 'Swap' });
  const net = ctx.wallet?.net, key = net?.key;
  const head = h('div.page-head', h('div', h('h1', 'Swap'), h('p.muted', 'Convert between the native coin, USDC and tokenized stocks on this network.')));
  if (ctx.mode === 'local' || !net?.mainnet || net.kind === 'solana') {
    root.append(head, callout('', 'info', 'Swap works on mainnet networks. Choose one with the network menu.'));
    return { root };
  }
  const body = h('div.swap-body', h('p.muted', 'Loading the assets on this network…'));
  root.append(head, body);
  let tokens = [], feeBps = 0, from = null, to = null, amount = '', slippage = 100, quote = null, quoteFor = '', busy = false, timer = null, balances = {};

  const balanceText = t => balances[t.address] == null ? '' : `Balance: ${number(Number(formatUnits(balances[t.address], t.decimals)), 6)} ${t.symbol}`;
  // The two assets on screen first, then the native coin, USDC and launch stocks a few at a time: reading all 476 BNB Chain
  // assets at once through the wallet's RPC took long enough that the page looked empty (Malik, 21 Nov). A swap-only
  // asset's balance is read when it is picked.
  async function balanceOf(t) {
    const me = ctx.wallet?.address; if (!me || !ctx.wallet.provider || !t) return;
    try { balances[t.address] = same(t.address, NATIVE) ? await ctx.wallet.provider.getBalance(me) : await new Contract(t.address, ERC20, ctx.wallet.provider).balanceOf(me); } catch { /* shown blank */ }
  }
  let balanceRun = 0;
  async function loadBalances() {
    if (!ctx.wallet?.address) return;
    const run = ++balanceRun;
    await Promise.all([from, to].map(balanceOf)); update();
    const rest = tokens.slice(0, 40).filter(t => balances[t.address] == null);
    for (let i = 0; i < rest.length && run === balanceRun; i += 4) await Promise.all(rest.slice(i, i + 4).map(balanceOf));
    if (run === balanceRun) update();
  }
  const pickBalance = t => { if (t && balances[t.address] == null) balanceOf(t).then(update); };
  const blocked = () => (from?.kind === 'xstock' || to?.kind === 'xstock') ? stockRegionOff() : null;
  const picker = (sel, onPick, label) => stockPicker({ assets: tokens.map(t => ({ ...t, id: t.address })), selectedId: sel?.address, label, noun: 'asset', emptyText: 'No asset matches.', onSelect: a => onPick(tokens.find(t => same(t.address, a.address))) });

  function requestQuote() {
    clearTimeout(timer); quote = null;
    const units = from ? toUnits(amount, from.decimals) : null;
    if (!units || !to || blocked()) { update(); return; }
    const want = `${from.address}:${to.address}:${units}`; quoteFor = want; update();
    timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/public/swap/quote?network=${encodeURIComponent(key)}&tokenIn=${from.address}&tokenOut=${to.address}&amountIn=${units}`);
        const d = await r.json(); if (quoteFor !== want) return;
        quote = r.ok ? { ...d, units } : { error: d.error ?? 'No route right now.' };
      } catch { if (quoteFor === want) quote = { error: 'Swap routing is unavailable right now.' }; }
      update();
    }, 450);
  }

  async function execute(button, error) {
    if (busy || !quote?.routeSummary) return;
    busy = true; button.disabled = true; error.textContent = '';
    try {
      const w = ctx.wallet; await w.checkNetwork();
      const units = quote.units;
      if (!same(from.address, NATIVE)) {
        const token = new Contract(from.address, ERC20, w.signer);
        if ((await token.allowance(w.address, KYBER_ROUTER)) < units) { button.textContent = `Approve ${from.symbol}…`; await (await token.approve(KYBER_ROUTER, units)).wait(); }
      }
      button.textContent = 'Confirm the swap in your wallet…';
      const tx = await ctx.api('swap/build', { network: key, routeSummary: quote.routeSummary, sender: w.address, slippageBps: slippage });
      if (!same(tx.to, KYBER_ROUTER)) throw new Error('Unexpected swap router; nothing was sent.');
      const sent = await w.signer.sendTransaction({ to: KYBER_ROUTER, data: tx.data, value: BigInt(tx.value ?? '0') });
      button.textContent = 'Waiting for confirmation…';
      await sent.wait();
      toast(`Swapped ${amount} ${from.symbol} for ${to.symbol}.`, { kind: 'success', link: w.txUrl ? { href: w.txUrl(sent.hash), label: 'View transaction' } : undefined });
      amount = ''; quote = null; await loadBalances();
    } catch (e) { error.textContent = errorText(e); }
    finally { busy = false; button.textContent = ''; draw(); }
  }

  // Built by draw() (token or direction changes); update() refreshes the quote parts without touching the amount input.
  let els = null;
  function update() {
    if (!els) return;
    const connected = !!ctx.wallet?.address, reason = blocked();
    els.out.textContent = quote?.amountOut ? number(Number(formatUnits(BigInt(quote.amountOut), to.decimals)), 6) : quoteFor && !quote && amount ? '…' : '0.00';
    els.error.textContent = quote?.error ?? '';
    els.gas.hidden = quote?.gasUsd == null; els.gasValue.textContent = quote?.gasUsd != null ? `≈ $${number(Number(quote.gasUsd), 2)}` : '';
    els.button.disabled = !connected || !quote?.routeSummary || !!reason || busy;
    // Balances arrive after the page is drawn: refresh their text and the 25/50/Max buttons in place.
    els.hint.textContent = balanceText(from);
    for (const b of els.portions.children) b.disabled = balances[from.address] == null;
  }
  function draw() {
    if (!tokens.length) return;
    const connected = !!ctx.wallet?.address;
    const input = h('input.input.swap-amount', { inputmode: 'decimal', placeholder: '0.00', value: amount, 'aria-label': `Amount of ${from.symbol} to swap`, on: { input: e => { amount = e.target.value.replace(',', '.'); requestQuote(); } } });
    const flip = h('button.btn.btn-ghost.btn-sm.swap-flip', { type: 'button', 'aria-label': 'Swap direction', on: { click: () => { [from, to] = [to, from]; amount = ''; quote = null; draw(); } } }, icon('arrow-down-up', 'icon-sm'));
    const setPortion = pct => {
      const bal = balances[from.address]; if (bal == null) return;
      const units = portionOf(bal, pct, { native: same(from.address, NATIVE), reserve: GAS_RESERVE[key] ?? 1_000_000_000_000_000n });
      if (units <= 0n) { amount = ''; quote = null; draw(); return; }
      amount = formatUnits(units, from.decimals).replace(/\.0$/, ''); input.value = amount; requestQuote();
    };
    const portions = h('div.swap-portions', PORTIONS.map(p => h('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: balances[from.address] == null, on: { click: () => setPortion(p) } }, p === 100 ? 'Max' : `${p}%`)));
    const out = quote?.amountOut ? number(Number(formatUnits(BigInt(quote.amountOut), to.decimals)), 6) : quoteFor && !quote && amount ? '…' : '0.00';
    const error = h('p.error-text', { role: 'alert' }, quote?.error ?? '');
    const reason = blocked();
    const button = h('button.btn.btn-block.btn-lg.btn-buy', { type: 'button', disabled: !connected || !quote?.routeSummary || !!reason || busy }, !connected ? 'Connect a wallet' : `Swap ${from.symbol} for ${to.symbol}`);
    button.addEventListener('click', () => execute(button, error));
    const outEl = h('strong', out), gasValue = h('strong'), gas = h('div.trade-meta', { hidden: true }, h('span', 'Network fee'), gasValue);
    const hint = h('span.hint', balanceText(from));
    els = { out: outEl, error, button, gas, gasValue, hint, portions };
    body.replaceChildren(h('div.swap-card.tk-card',
      h('div.pay-box', h('div.swap-card-top', h('label', 'You pay'), hint), h('div.pay-input', input), portions, picker(from, t => { if (same(t.address, to.address)) to = from; from = t; amount = ''; quote = null; draw(); pickBalance(t); }, 'Pay with')),
      h('div.swap-direction', flip),
      h('div.receive', h('div.swap-card-top', h('span', 'You receive'), h('span.hint', 'Estimated')), h('div.swap-receive-row', outEl), picker(to, t => { if (same(t.address, from.address)) from = to; to = t; quote = null; requestQuote(); pickBalance(t); }, 'Receive')),
      h('div.trade-meta', h('span', 'Slippage'), h('div.segmented', SLIPPAGES.map(b => h('button', { type: 'button', 'aria-pressed': String(b === slippage), on: { click: () => { slippage = b; draw(); } } }, `${b / 100}%`)))),
      feeBps ? h('div.trade-meta', h('span', 'Elpida fee'), h('strong', `${feeBps / 100}%`)) : null,
      gas,
      reason ? callout('warn', 'lock', reason) : null,
      !connected ? h('div', ctx.walletButtons(net, { onDone: () => { loadBalances(); draw(); }, onError: e => { error.textContent = errorText(e); } })) : null,
      error, button,
      h('p.small.muted', `Routed by KyberSwap across the network’s DEX pools.${feeBps ? ` The ${feeBps / 100}% Elpida fee is included in the quote above and goes to the Elpida treasury.` : ''} You approve and sign in your own wallet; Elpida never holds your funds.`)));
    update();
  }

  fetch(`/api/public/swap/tokens?network=${encodeURIComponent(key)}`).then(r => r.json()).then(d => {
    if (!d.available) { body.replaceChildren(callout('', 'info', `Swap is not available on ${net.name} yet.`)); return; }
    tokens = d.tokens; feeBps = Number(d.feeBps ?? 0); from = tokens[0]; to = tokens.find(t => t.kind === 'usdc') ?? tokens[1];
    draw(); loadBalances(); loadStockCatalog().then(() => draw());
  }).catch(() => body.replaceChildren(callout('error', 'triangle-alert', 'Swap is unavailable right now. Refresh shortly.')));
  return { root };
}
