// Token detail page: market figures with plain definitions, bonding-curve progress, trade panel,
// graduation actions, creator-fee summary and technical details.
import { h, icon, short, number, compact, avatar, pricing, fmtPrice, fmtValue, progressOf, lifecycle, metadataLinks, copyButton, callout, errorText, toast } from './ui.mjs';

const SVGNS = 'http://www.w3.org/2000/svg';
// Compare decimal amounts without rounding away the last token/native-asset unit.
export function exceedsRemaining(amount, remaining) {
  const decimal = value => {
    const match = String(value).match(/^(\d+)(?:\.(\d*))?$/);
    return match && {whole:match[1],fraction:match[2] ?? ''};
  };
  const a = decimal(amount), b = decimal(remaining);
  if (!a || !b) return false;
  const places = Math.max(a.fraction.length,b.fraction.length);
  const units = value => BigInt(value.whole + value.fraction.padEnd(places,'0'));
  return units(a) > units(b);
}
function svg(tag, attrs) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }

/** Curve progress drawn as a rising arc over the horizon, echoing the Elpida mark. */
function dawnArc(percent, done) {
  const root = svg('svg', { viewBox: '0 0 148 84', role: 'img', 'aria-label': `${Math.round(percent)}% of the bonding curve sold` });
  const path = 'M10 74 A64 64 0 0 1 138 74';
  const length = Math.PI * 64;
  root.append(svg('path', { d: path, class: 'arc-track', fill: 'none', 'stroke-width': '10', 'stroke-linecap': 'round' }));
  const fill = svg('path', { d: path, class: 'arc-fill', fill: 'none', 'stroke-width': '10', 'stroke-linecap': 'round', 'stroke-dasharray': String(length), 'stroke-dashoffset': String(length) });
  root.append(fill, svg('line', { x1: '2', y1: '80', x2: '146', y2: '80', class: 'arc-horizon', 'stroke-width': '3', 'stroke-linecap': 'round' }));
  const label = svg('text', { x: '74', y: '68', 'text-anchor': 'middle', class: 'arc-value' }); label.textContent = `${number(percent, 1)}%`;
  root.append(label);
  requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', String(length * (1 - percent / 100))));
  return h('div.dawn-arc', { 'data-state': done ? 'done' : 'open' }, root);
}

function dexName(ctx, token) {
  if (token.venue) return token.venue;
  if (token.dex) return token.dex;
  return (ctx.mode === 'local' ? ctx.config.dex : ctx.wallet.dex) ? 'Uniswap v3' : 'test';
}

export function renderToken(ctx, address) {
  const state = ctx.state;
  const token = state.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
  if (!token) {
    return h('div', h('a.back-link', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'All tokens'),
      h('div.empty', h('h3', 'Token not found on this network'), h('p', state.disconnected ? 'Connect your wallet to load this network.' : `This token is not listed on ${ctx.envLabel()}. It may belong to another network or to a local session that has restarted.`),
        h('a.btn.btn-primary', { href: '#/' }, 'Back to tokens')));
  }
  const p = pricing(token), pct = progressOf(token), life = lifecycle(token), q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH', dex = dexName(ctx, token);
  const solana = ctx.mode === 'testnet' && ctx.wallet === ctx.solWallet;

  const head = h('div.token-head', avatar(token, 'avatar-lg'),
    h('div', h('h1', token.name, h('span.sym', `$${token.symbol}`)),
      h('div.chips', h(`span.chip${life.chip ? '.' + life.chip : ''}`, life.label), h(`span.chip.${ctx.mode === 'local' ? 'chip-sim' : 'chip-testnet'}`, ctx.envLabel()), h('span.chip', `Trading pair: ${q}`))),
    h('div.head-actions', copyButton(token.address, `Token ${short(token.address)}`)));

  const metric = (label, value, note) => h('div.metric', h('span', label), h('strong', value), note ? h('small', note) : null);
  const figures = h('section.panel', { 'aria-labelledby': 'market-title' },
    h('div.panel-head', h('div', h('h2#market-title', 'Market'), h('p', `Values shown in ${q}, the trading pair. No dollar conversion is assumed.`))),
    h('div.metrics',
      metric('Price', fmtPrice(token), token.graduated ? `${dex} pool price` : 'Current bonding-curve price'),
      metric('Market cap', fmtValue(p.marketCap, token), 'Price × circulating supply'),
      metric('Fully diluted value', fmtValue(p.fdv, token), 'Price × total supply'),
      metric('Total supply', compact(token.supply), 'Fixed at launch, never minted again'),
      metric('Circulating supply', compact(p.circulating), 'Held outside the curve and pool'),
      metric('Trading reserve', `${number(token.reserve, 4)} ${q}`, token.graduated ? 'Moved into the locked DEX pool' : 'Real funds held by the curve')));

  let curveText;
  if (token.graduated) curveText = h('div', h('h3', `Graduated to ${dex === 'test' ? 'a locked test pool' : dex}`), h('p.muted', `The curve sold out. Its trading reserve and the remaining tokens opened a ${dex} pool at the final curve price, and that liquidity is locked permanently.`));
  else if (token.complete) curveText = h('div', h('h3', 'Curve complete'), h('p.muted', `Trading on the curve has stopped. Graduating moves the ${number(token.reserve, 2)} ${q} trading reserve and the remaining tokens into a ${dex} pool with permanently locked liquidity. Anyone can trigger it.`));
  else curveText = h('div', h('h3', `${number(pct, 1)}% of the curve sold`),
    h('p.muted', `This is a virtual bonding curve, not a funded pool: purchases build the trading reserve. When the curve sells out, the reserve and the remaining tokens open a ${dex} pool at the final price, and that liquidity is locked.`),
    token.remainingBuy ? h('p.small', `About ${number(token.remainingBuy, 2)} ${q} of purchases completes the curve.`) : null);
  const curve = h('section.panel', { 'aria-labelledby': 'curve-title' }, h('h2#curve-title.visually-hidden', 'Bonding curve'), h('div.dawn-arc', { 'data-state': token.complete || token.graduated ? 'done' : 'open' }, dawnArc(pct, token.complete || token.graduated).firstChild, curveText));

  const about = h('section.panel', { 'aria-labelledby': 'about-title' }, h('h2#about-title', 'About'),
    h('p', { class: 'section-text' }, token.metadata?.description || 'The creator has not added a description.'), metadataLinks(token.metadata),
    token.metadataURI ? h('p.small.muted', token.metadataStatus === 'unavailable' ? 'Published metadata is temporarily unavailable.' : 'Metadata reference recorded on-chain.') : null);
  about.querySelector('.section-text').style.margin = '12px 0';

  const fees = h('section.panel', { 'aria-labelledby': 'fees-title' }, h('h2#fees-title', 'Creator fees'),
    h('p.muted.small', { text: token.rewardVault ? 'Creator fees go to this token’s reward treasury and follow the strategy chosen at launch.' : `Each curve trade pays 1.25%: half to Elpida, half to the creator wallet ${short(token.reward)}.` }),
    h('dl.kv', { class: 'section-kv' }, h('dt', 'Creator fees not yet distributed'), h('dd', `${number(token.creatorFees, 6)} ${q}`), h('dt', 'Elpida fees not yet distributed'), h('dd', `${number(token.protocolFees, 6)} ${q}`)),
    h('a.link-button', { href: '#/rewards' }, 'Open rewards', icon('chevron-right', 'icon-sm')));
  fees.querySelector('.section-kv').style.margin = '12px 0';

  const activity = (ctx.mode === 'local' ? state.activity ?? [] : []).filter(a => a.symbol === token.symbol).slice(0, 8);
  const activityPanel = ctx.mode === 'local' ? h('section.panel', h('h2', 'Recent trades'), activity.length ? h('div.activity', { class: 'flush' }, activity.map(a => h('div.activity-row', h('span.glyph', { 'data-kind': a.type }, icon(a.type === 'Sell' ? 'trending-up' : 'arrow-down-up', 'icon-sm')), h('div', h('strong', a.type === 'Fees paid' ? 'Creator fees distributed' : a.type), h('span.meta', a.amount ? `${number(a.amount, 4)} ${a.type === 'Sell' ? token.symbol : a.quoteSymbol ?? q}` : '')), h('span.meta.who', short(a.account)), h('span.meta', new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))))) : h('p.muted.small', 'No trades in this session yet.')) : null;

  const tech = h('details.tech', h('summary', 'Technical details', icon('chevron-down', 'icon-sm')), h('dl.kv',
    h('dt', 'Token address'), h('dd', token.address),
    token.curve ? [h('dt', 'Bonding curve'), h('dd', token.curve)] : null,
    token.pool && !/^0x0+$/.test(token.pool) ? [h('dt', 'Pool'), h('dd', token.pool)] : null,
    token.pumpPool ? [h('dt', 'PumpSwap pool'), h('dd', token.pumpPool)] : null,
    token.quoteAddress ? [h('dt', `${q} address`), h('dd', token.quoteAddress)] : null,
    h('dt', 'Creator'), h('dd', token.creator), h('dt', 'Creator fee wallet'), h('dd', token.reward),
    token.metadataURI ? [h('dt', 'Metadata URI'), h('dd', token.metadataURI)] : null,
    token.url ? [h('dt', 'Explorer'), h('dd', h('a', { href: token.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in explorer'))] : null));

  return h('div', h('a.back-link', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'All tokens'), head,
    h('div.token-layout', h('div.stack', figures, curve, about, fees, activityPanel, tech), h('aside', tradePanel(ctx, token, { dex, solana }))));
}

function tradePanel(ctx, token, { dex, solana }) {
  const q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH';
  if (token.graduated && token.venue === 'PumpSwap') {
    return h('section.panel.trade-panel', h('h2', 'Trade'), h('p.muted', `${token.symbol} now trades on PumpSwap. Its liquidity is locked permanently, and its LP fees are harvested 50/50 to Elpida and the creator.`),
      token.dexUrl ? h('a.btn.btn-primary.btn-block', { href: token.dexUrl, target: '_blank', rel: 'noopener noreferrer', style: undefined }, 'Open the PumpSwap pool', icon('external-link', 'icon-sm')) : null);
  }
  if (token.complete && !token.graduated) {
    const error = h('p.error-text', { role: 'alert' });
    const label = token.dex === 'PumpSwap' ? 'Migrate to PumpSwap' : `Graduate to ${dex === 'test' ? 'a locked test pool' : dex}`;
    return h('section.panel.trade-panel', h('h2', 'Curve complete'), h('p.muted', `Curve trading has stopped. ${label} to open the DEX pool. ${solana ? 'You advance about 0.05 SOL of account rent; the unused part is refunded in the same transaction.' : 'You pay the network fee.'}`),
      h('button.btn.btn-primary.btn-block', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run('graduate', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, label), error);
  }
  let side = 'buy', revision = 0, timer, quoteReady = false, submitting = false;
  const amount = h('input.input#trade-amount', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0.00', required: true, 'aria-describedby': 'trade-balance' });
  const unit = h('span.affix');
  const balance = h('p.hint#trade-balance');
  const shortcuts = h('div.shortcuts', { role: 'group', 'aria-label': 'Amount shortcuts' });
  const out = h('strong', 'Enter an amount'), fee = h('strong', '—'), feeNote = h('p.hint');
  const error = h('p.error-text', { role: 'alert' });
  const slippage = h('select.select#trade-slippage', [['0.5', '0.5%'], ['1', '1%'], ['3', '3%'], ['5', '5%']].map(([v, l]) => h('option', { value: v, selected: v === '1' }, l)));
  const submit = h('button.btn.btn-block.btn-lg', { type: 'submit', disabled:true });
  const updateSubmit = () => { submit.disabled = !quoteReady || submitting; };
  const remaining = !token.complete && !token.graduated && Number(token.remainingBuy) > 0;
  const remainingHint = h('p.hint', remaining ? `About ${number(token.remainingBuy,8)} ${q} remains to complete the curve. Further trading continues after graduation into the locked pool.` : '');
  const useRemaining = h('button.btn.btn-secondary.btn-sm.curve-limit-action', {type:'button',hidden:true,on:{click:()=>{amount.value=token.remainingBuy;quote();}}}, 'Use remaining amount');
  const tabs = h('div.segmented', { role: 'tablist', 'aria-label': 'Trade side' }, ['buy', 'sell'].map(s => h('button', { type: 'button', role: 'tab', 'data-side': s, 'aria-selected': String(s === side), on: { click: () => setSide(s) } }, s === 'buy' ? 'Buy' : 'Sell')));
  const quoteBalance = () => token.pair === 'native' ? `${number(ctx.state.nativeBalance ?? 0, 6)} ${q}` : token.quoteAddress && ctx.state.balanceSymbol && ctx.state.balanceSymbol !== q ? null : `${number(ctx.state.balance, 4)} ${ctx.state.balanceSymbol ?? q}`;
  function setSide(next) {
    side = next; revision++; clearTimeout(timer);
    quoteReady = false; updateSubmit(); useRemaining.hidden = true; remainingHint.hidden = side !== 'buy';
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.side === side)));
    unit.textContent = side === 'buy' ? q : token.symbol;
    submit.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`;
    submit.className = `btn btn-block btn-lg ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`;
    amount.value = ''; out.textContent = 'Enter an amount'; fee.textContent = '—'; feeNote.textContent = ''; error.textContent = '';
    const qb = quoteBalance();
    balance.textContent = side === 'buy' ? (qb ? `Available: ${qb}` : '') : `Available: ${number(token.balance, 4)} ${token.symbol}`;
    const presets = side === 'buy' ? [...(token.pair === 'native' ? ['0.01', '0.05', '0.1'] : ['10', '25', '100']), ...(!token.complete && token.remainingBuy ? ['Complete curve'] : [])] : ['25%', '50%', '100%'];
    shortcuts.replaceChildren(...presets.map(value => h('button.btn.btn-secondary.btn-sm', { type: 'button', on: { click: () => {
      if (side === 'buy') amount.value = value === 'Complete curve' ? token.remainingBuy : value;
      else {
        // Integer arithmetic so 100% never exceeds the actual balance.
        const decimals = token.decimals ?? 18, scale = 10n ** BigInt(decimals);
        const [whole, fraction = ''] = String(token.balance).split('.');
        const units = BigInt(whole || '0') * scale + BigInt((fraction.slice(0, decimals) || '0').padEnd(decimals, '0'));
        const part = units * BigInt(value.slice(0, -1)) / 100n;
        amount.value = `${part / scale}.${(part % scale).toString().padStart(decimals, '0')}`.replace(/\.?0+$/, '') || '0';
      }
      quote();
    } } }, side === 'buy' && value !== 'Complete curve' ? `${value} ${q}` : value)));
  }
  function quote() {
    const value = amount.value, rev = ++revision; clearTimeout(timer); error.textContent = '';
    quoteReady = false; updateSubmit(); useRemaining.hidden = true;
    if (!(Number(value) > 0)) { out.textContent = 'Enter an amount'; fee.textContent = '—'; feeNote.textContent = ''; return; }
    if (side === 'buy' && remaining && exceedsRemaining(value,token.remainingBuy) && !solana) {
      out.textContent = 'Amount exceeds the curve limit'; fee.textContent = '—'; feeNote.textContent = '';
      error.textContent = `About ${number(token.remainingBuy,8)} ${q} remains on the bonding curve. Use the remaining-amount button to fill the exact limit, then graduate to the locked pool.`;
      useRemaining.hidden = false; return;
    }
    fee.textContent = '—'; feeNote.textContent = '';
    out.textContent = 'Getting quote…';
    timer = setTimeout(async () => {
      try {
        const result = ctx.mode === 'local' ? await ctx.api('quote', { token: token.address, side, amount: value }) : await ctx.wallet.getQuote({ token: token.address, side, amount: value });
        if (rev !== revision) return;
        quoteReady = true; updateSubmit();
        out.textContent = `${number(result.out, side === 'buy' ? 2 : 6)} ${side === 'buy' ? token.symbol : q}`;
        fee.textContent = `${number(result.fee, 6)} ${result.feeSymbol ?? q}`;
        feeNote.textContent = result.antiSnipeActive ? `Launch protection is active: the fee is ${number(result.feeBps / 100, 2)}% for the first minute and falls to 1.25%. The amount above 1.25% is added to the token's locked liquidity.` : result.completesCurve ? `This purchase completes the curve. Only ${number(result.spend, 4)} ${q} will be charged.` : '';
      } catch (e) { if (rev !== revision) return; out.textContent = 'Quote unavailable'; fee.textContent = '—'; error.textContent = errorText(e); }
    }, 300);
  }
  amount.addEventListener('input', quote);
  const form = h('form', { class: 'stack', on: { submit: async event => {
    event.preventDefault(); error.textContent = '';
    if (!(Number(amount.value) > 0)) { error.textContent = 'Enter an amount greater than zero.'; amount.focus(); return; }
    if (!quoteReady || submitting) { quote(); return; }
    if (ctx.mode === 'testnet' && !ctx.wallet.address) { error.textContent = 'Connect your wallet first.'; return; }
    submitting = true; updateSubmit();
    try { await ctx.run(side, { token: token.address, amount: amount.value, slippage: slippage.value }); }
    catch (e) { error.textContent = errorText(e); }
    finally { submitting = false; updateSubmit(); }
  } } },
    tabs,
    h('div.field', h('label', { for: 'trade-amount' }, side === 'buy' ? 'You pay' : 'You sell'), h('div.input-affix', amount, unit), balance),
    shortcuts, remainingHint, useRemaining,
    h('div.field', h('label', { for: 'trade-slippage' }, 'Slippage tolerance'), slippage, h('p.hint', 'The trade fails instead of filling at a worse price than this.')),
    h('div.quote', h('div', h('span', 'You receive (estimate)'), out), h('div', h('span', 'Trading fee included'), fee)),
    feeNote, error, submit);
  form.querySelector('label[for=trade-amount]').dataset.dynamic = 'true';
  tabs.addEventListener('click', () => { form.querySelector('label[for=trade-amount]').textContent = side === 'buy' ? 'You pay' : 'You sell'; });
  setSide('buy');
  return h('section.panel.trade-panel', { 'aria-labelledby': 'trade-title' }, h('h2#trade-title', 'Trade'),
    h('p.small.muted', token.graduated ? `Trades route through the locked ${dex} pool.` : 'Trades are priced by the bonding curve. Each trade pays a 1.25% fee.'),
    h('div', { class: 'trade-gap' }), form);
}
