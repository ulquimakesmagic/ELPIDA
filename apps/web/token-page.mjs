// Token detail page: market figures with plain definitions, bonding-curve progress, trade panel,
// graduation actions, creator-fee summary and technical details.
import { h, icon, short, number, compact, avatar, pricing, fmtPrice, fmtValue, progressOf, lifecycle, copyButton, errorText, toast, usdRate, formatPrice, bar } from './ui.mjs';

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

function dexName(ctx, token) {
  if (token.venue) return token.venue;
  if (token.dex) return token.dex;
  return (ctx.mode === 'local' ? ctx.config.dex : ctx.wallet.dex) ? 'Uniswap v3' : 'test';
}

/** "3m ago" style relative age, used by the header and the trades table. */
export function ago(seconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 30)}mo`;
}
const toSeconds = value => { const n = Number(value); return !Number.isFinite(n) || n <= 0 ? null : n > 1e12 ? Math.floor(n / 1000) : n; };

// Post-launch page, structured like the Pons token page: identity and headline market cap, chart,
// curve progress, a stats row, contract addresses, about, trades/holders and a sticky trade panel.
export function renderToken(ctx, address) {
  const state = ctx.state;
  const token = state.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
  if (!token) {
    return h('div', h('a.back-link', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'Launches'),
      h('div.empty', h('h3', 'Token not found on this network'), h('p', state.disconnected ? 'Connect your wallet to load this network.' : `This token is not listed on ${ctx.envLabel()}. It may belong to another network or to a local session that has restarted.`),
        h('a.btn.btn-primary', { href: '#/' }, 'Back to launches')));
  }
  const p = pricing(token), pct = progressOf(token), life = lifecycle(token), q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH', dex = dexName(ctx, token);
  const solana = ctx.mode === 'testnet' && ctx.wallet === ctx.solWallet;
  const explorer = token.url ? token.url.replace(/\/(token|address)\/.*$/, '') : ctx.mode === 'testnet' ? ctx.wallet?.net?.explorer : null;
  const addressUrl = a => explorer ? `${explorer}/address/${a}${solana && ctx.wallet.net.cluster !== 'mainnet' ? `?cluster=${ctx.wallet.net.cluster}` : ''}` : null;
  const created = toSeconds(token.created);
  const isCreator = a => a && token.creator && a.toLowerCase() === token.creator.toLowerCase();
  const external = (href, label) => href ? h('a.icon-link', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, title: label }, icon('external-link', 'icon-sm')) : null;
  const social = token.metadata ?? {};

  const byline = h('div.byline',
    token.creator ? h('span', 'by ', h('a.creator-link', { href: addressUrl(token.creator) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.creator))) : null,
    created ? h('span', `${ago(created)} ago`) : null,
    h('span', `${q} pair`),
    h('span.addr', short(token.address), copyButton(token.address, '')),
    external(token.url ?? addressUrl(token.address), 'Open in explorer'),
    ...[['twitter', 'X'], ['telegram', 'Telegram'], ['website', 'Website'], ['discord', 'Discord']].filter(([k]) => social[k]).map(([k, label]) => h('a.chip.chip-link', { href: social[k], target: '_blank', rel: 'noopener noreferrer' }, label)));
  const head = h('header.token-hero', avatar(token, 'avatar-lg'),
    h('div.token-identity', h('h1', token.name, h('span.sym', token.symbol)), byline,
      h('div.chips', h(`span.chip${life.chip ? '.' + life.chip : ''}`, life.label), h(`span.chip.${ctx.mode === 'local' ? 'chip-sim' : 'chip-testnet'}`, ctx.envLabel()))),
    h('div.market-headline', h('span.meta', 'Market cap'), h('strong', fmtValue(p.marketCap, token)), h('span.meta', `${fmtPrice(token)} price`)));

  // Curve progress: real reserve raised toward the reserve that completes the curve (net of the fee).
  const reserve = Number(token.reserve || 0), remainingNet = Number(token.remainingBuy || 0) * (1 - 0.0125);
  const target = reserve + remainingNet, raisedPct = token.complete || token.graduated ? 100 : target > 0 ? reserve / target * 100 : pct;
  const curve = h('section.curve-strip', { 'aria-label': 'Bonding curve progress' },
    h('div.curve-line', h('span', token.graduated ? `Graduated to ${dex === 'test' ? 'a locked test pool' : dex}` : token.complete ? 'Curve complete · ready to graduate' : 'Curve'),
      h('span.meta', token.graduated ? 'Liquidity locked permanently' : target > 0 ? `${number(raisedPct, raisedPct < 1 ? 2 : 1)}% of ${number(target, 2)} ${q}` : `${number(pct, 1)}% sold`)),
    bar(raisedPct, token.complete || token.graduated, 'Bonding curve progress'),
    !token.graduated ? h('p.small.muted', token.complete ? `Anyone can graduate it: the ${number(reserve, 4)} ${q} reserve and the remaining tokens open a ${dex} pool with permanently locked liquidity.` : `Virtual bonding curve: purchases build the reserve. About ${number(token.remainingBuy, 4)} ${q} more completes it, then the liquidity moves into a locked ${dex} pool.`) : null);

  const stat = (label, value, extra) => h('div.stat', h('span', label), h('strong', value), extra ?? null);
  const holdersValue = h('strong', '—'), tradesValue = h('strong', '—');
  const creatorFees = Number(token.creatorFees || 0);
  const stats = h('section.stat-row', { 'aria-label': 'Token statistics' },
    stat('Market cap', fmtValue(p.marketCap, token)),
    h('div.stat', h('span', 'Holders'), holdersValue),
    h('div.stat', h('span', 'Trades'), tradesValue),
    stat('Supply', compact(token.supply || 1e9)),
    token.graduated || creatorFees > 0
      ? stat('Creator unclaimed', usdRate(token) !== null ? '$' + number(creatorFees * usdRate(token), 2) : `${number(creatorFees, 6)} ${q}`, h('a.small', { href: '#/rewards' }, creatorFees > 0 ? 'Claim in Rewards' : 'Open Rewards'))
      : stat('Creator fee', '0.625%', h('small.muted', 'Half of the 1.25% trade fee')));

  const addresses = h('section.address-row', { 'aria-label': 'Contract addresses and dates' },
    h('div', h('span', 'Token'), h('a', { href: addressUrl(token.address) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.address))),
    token.curve ? h('div', h('span', 'Curve'), h('a', { href: addressUrl(token.curve) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.curve))) : null,
    token.pool && !/^0x0+$/.test(token.pool) && token.graduated ? h('div', h('span', 'Pool'), h('a', { href: addressUrl(token.pool) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.pool))) : null,
    created ? h('div', h('span', 'Launched'), h('strong', new Date(created * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))) : null,
    token.graduated && toSeconds(token.completedAt ?? token.graduatedAt) ? h('div', h('span', 'Graduated'), h('strong', new Date(toSeconds(token.completedAt ?? token.graduatedAt) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))) : null);

  const about = h('section.about', { 'aria-labelledby': 'about-title' }, h('h2#about-title', 'About'),
    h('p.section-text', token.metadata?.description || 'The creator has not added a description.'),
    token.metadataURI ? h('p.small.muted', token.metadataStatus === 'unavailable' ? 'Published metadata is temporarily unavailable.' : 'Metadata reference recorded on-chain.') : null);
  if(ctx.mode==='testnet'&&!token.metadataURI&&token.metadataStatus!=='creator-signed'&&token.creator?.toLowerCase()===state.wallet?.toLowerCase()&&(token.metadata?.image||token.metadata?.description)){
    const publish=h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:async()=>{publish.disabled=true;try{const body={network:ctx.currentChain(),token:token.address,metadata:token.metadata,expires:Math.floor(Date.now()/1000)+240};const prepared=await ctx.api('public/metadata/prepare',body);const signature=await ctx.wallet.signer.signMessage(prepared.message);await ctx.api('public/metadata/save',{...body,signature});toast('Token details saved to the public server.',{kind:'success'});await ctx.refresh();}catch(e){toast(errorText(e),{kind:'error'});}finally{publish.disabled=false;}}}},'Publish saved token details');
    about.append(h('p.small.muted','These token details are saved only in this browser. Publish them with a creator signature so every visitor sees them.'),publish);
  }

  const tech = h('details.tech', h('summary', 'Technical details', icon('chevron-down', 'icon-sm')), h('dl.kv',
    h('dt', 'Token address'), h('dd', token.address),
    token.curve ? [h('dt', 'Bonding curve'), h('dd', token.curve)] : null,
    token.pool && !/^0x0+$/.test(token.pool) ? [h('dt', 'Pool'), h('dd', token.pool)] : null,
    token.pumpPool ? [h('dt', 'PumpSwap pool'), h('dd', token.pumpPool)] : null,
    token.quoteAddress && !/^0x0+$/.test(token.quoteAddress) ? [h('dt', `${q} address`), h('dd', token.quoteAddress)] : null,
    h('dt', 'Creator'), h('dd', token.creator ?? '—'), h('dt', 'Creator fee wallet'), h('dd', token.reward ?? '—'),
    h('dt', 'Trading reserve'), h('dd', `${number(token.reserve, 6)} ${q}`),
    h('dt', 'Fees not yet distributed'), h('dd', `${number(token.creatorFees, 6)} ${q} creator · ${number(token.protocolFees, 6)} ${q} Elpida`),
    h('dt','Market cap convention'),h('dd','Market cap = price × total supply (1,000,000,000). The whole supply is minted at launch into the curve, so circulating supply equals total supply.'),
    token.metadataURI ? [h('dt', 'Metadata URI'), h('dd', token.metadataURI)] : null));

  const activity = marketActivity(ctx, token, q, { addressUrl, isCreator, onCounts: ({ holders, trades }) => { holdersValue.textContent = holders ?? '—'; tradesValue.textContent = trades ?? '—'; } });
  return h('div.token-page', h('a.back-link', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'Launches'), head,
    h('div.token-layout', h('div.stack', priceHistory(ctx,token,q), curve, stats, addresses, about, activity, tech), h('aside.trade-aside', tradePanel(ctx, token, { dex, solana }))));
}

function priceHistory(ctx,token,q){
  let interval=60,basis='cap',style='candles',revision=0;
  const content=h('div',h('p.muted.small','Loading indexed price history…'));
  const explanation=h('p.small.muted');
  const controls=h('div.chart-controls');
  const headline=h('strong.chart-value',fmtValue(pricing(token).marketCap,token)),change=h('span.chart-change');
  const panel=h('section.panel.price-history',{'aria-label':'Market cap chart'},h('div.chart-top',h('div',headline,change),controls),content,explanation);
  const endpoint=ctx.mode==='local'?`tokens/${token.address}`:`public/tokens/${token.address}`;
  const network=ctx.mode==='local'?'':`&network=${encodeURIComponent(ctx.currentChain())}`;
  const buttons=(label,values,current,update)=>h('div.chart-options',{role:'group','aria-label':label},values.map(([value,text])=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(value===current),on:{click:()=>{update(value);drawControls();load();}}},text)));
  function drawControls(){controls.replaceChildren(buttons('Chart value',[['cap','MC'],['price','Price']],basis,v=>basis=v),buttons('Chart style',[['line','Line'],['candles','Candles']],style,v=>style=v),buttons('Chart interval',[[60,'1m'],[300,'5m'],[3600,'1h'],[86400,'1D']],interval,v=>interval=v));}
  const load=async()=>{
    const request=++revision;content.setAttribute('aria-busy','true');
    try{
      const data=await ctx.api(`${endpoint}/candles?interval=${interval}${network}`);
      if(!panel.isConnected||request!==revision)return;
      const points=data.filter(p=>Number.isFinite(Number(p.close))&&Number(p.close)>0&&Number.isSafeInteger(p.timestamp)).slice(-100);
      if(!points.length){content.replaceChildren(h('p.muted.small','No indexed trades yet. The chart appears after the first trade.'));return;}
      const rate=usdRate(token),multiplier=(basis==='cap'?Number(token.supply):1)*(rate??1),unit=rate===null?q:'USD';
      explanation.textContent=`${basis==='cap'?'Market cap (price × 1B supply)':'Price'} in ${unit}, from executed trades.${rate===null?'':' Past trades are converted at the current USD rate.'}`;
      const first=Number(points[0].open),last=Number(points.at(-1).close),move=first>0?(last-first)/first*100:0;
      headline.textContent=basis==='cap'?fmtValue(pricing(token).marketCap,token):fmtPrice(token);
      change.textContent=`${move>=0?'+':''}${number(move,2)}% · ${{60:'1m',300:'5m',3600:'1h',86400:'1D'}[interval]} candles`;change.dataset.dir=move>=0?'up':'down';
      const bars=points.map(p=>({...p,open:Number(p.open)*multiplier,high:Number(p.high)*multiplier,low:Number(p.low)*multiplier,close:Number(p.close)*multiplier}));
      const low=Math.min(...bars.map(p=>p.low)),high=Math.max(...bars.map(p=>p.high)),span=high-low||high*.02;
      const t0=points[0].timestamp,t1=points.at(-1).timestamp,x=i=>t0===t1?300:24+(points[i].timestamp-t0)*530/(t1-t0),y=v=>200-(v-low)*160/span;
      const plot=svg('svg',{viewBox:'0 0 640 240',role:'img','aria-label':`${points.length} indexed intervals. Latest ${basis==='cap'?'market cap':'price'} ${bars.at(-1).close} ${unit}.`});
      for(const yy of [40,120,200]){plot.append(svg('line',{x1:'24',x2:'555',y1:String(yy),y2:String(yy),class:'chart-grid'}));const label=svg('text',{x:'565',y:String(yy+4),class:'chart-axis'});label.textContent=(rate===null?'':'$')+compact(low+(200-yy)*span/160);plot.append(label);}
      if(style==='line')plot.append(svg('polyline',{points:bars.map((v,i)=>`${x(i)},${y(v.close)}`).join(' '),class:'chart-line',fill:'none'}));
      else for(const [i,b]of bars.entries()){const width=Math.max(2,Math.min(12,360/bars.length)),cls=b.close>=b.open?'candle-up':'candle-down';plot.append(svg('line',{x1:String(x(i)),x2:String(x(i)),y1:String(y(b.high)),y2:String(y(b.low)),class:cls}),svg('rect',{x:String(x(i)-width/2),y:String(Math.min(y(b.open),y(b.close))),width:String(width),height:String(Math.max(2,Math.abs(y(b.open)-y(b.close)))),class:cls}));}
      content.replaceChildren(plot,h('div.chart-caption',h('span',new Date(t0*1000).toLocaleString()),h('span',`${points.length} traded interval${points.length===1?'':'s'}`),h('span',new Date(t1*1000).toLocaleTimeString())));
    }catch{if(request===revision)content.replaceChildren(h('p.muted.small','Price history is temporarily unavailable or still indexing.'),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:load}},'Retry chart'));}
    finally{if(request===revision)content.setAttribute('aria-busy','false');}
  };drawControls();load();return panel;
}

function marketActivity(ctx,token,q,{addressUrl,isCreator,onCounts}){
  const content=h('div',h('p.muted.small','Loading trades…')),total=h('span.meta'),tabs=h('div.tabs-underline',{role:'tablist','aria-label':'Trades and holders'});
  const panel=h('section.activity-panel',h('div.activity-head',tabs,total),content);let selected='trades',revision=0;
  const base=ctx.mode==='local'?`tokens/${token.address}`:`public/tokens/${token.address}`,net=ctx.mode==='local'?'':`?network=${encodeURIComponent(ctx.currentChain())}`;
  const fetchKind=kind=>ctx.api(`${base}/${kind}${net}`);
  const usd=usdRate(token);
  const priceCell=row=>{const price=Number(row.quoteAmount)/Number(row.tokenAmount);return Number.isFinite(price)&&price>0?(usd!==null?formatPrice(price*usd):`${formatPrice(price,'')} ${q}`):'—';};
  const trader=a=>h('span.trader',h('a',{href:addressUrl(a)??'#',target:'_blank',rel:'noopener noreferrer'},short(a)),isCreator(a)?h('span.badge-dev',{title:'The creator of this token'},'Dev'):null);
  async function load(){const current=++revision;
    tabs.replaceChildren(...['trades','holders'].map(kind=>h('button',{type:'button',role:'tab','aria-selected':String(selected===kind),on:{click:()=>{selected=kind;load();}}},kind==='trades'?'Trades':'Holders')));
    try{const rows=await fetchKind(selected);if(current!==revision||!panel.isConnected)return;
      total.textContent=`${rows.length}${rows.length>=100?'+':''} ${selected==='trades'?'total':'holders'}`;
      const table=selected==='trades'
        ?h('table.market-table',h('thead',h('tr',...['Side','Trader',q,token.symbol,'Price','Age'].map((label,i)=>h('th',{scope:'col',class:i>1?'num':''},label)))),h('tbody',rows.map(row=>h('tr',
            h('td',{class:row.side==='buy'?'trade-buy':'trade-sell'},h('span.side',icon(row.side==='buy'?'trending-up':'trending-down','icon-sm'),row.side==='buy'?'Buy':'Sell')),
            h('td',trader(row.account)),h('td.num',number(row.quoteAmount,Number(row.quoteAmount)<0.001?6:3)),h('td.num',compact(row.tokenAmount)),h('td.num',priceCell(row)),
            h('td.num',row.hash&&addressUrl(row.account)?h('a',{href:addressUrl(row.account).replace(/\/address\/[^?]+/,'/tx/'+row.hash),target:'_blank',rel:'noopener noreferrer',title:new Date(row.timestamp*1000).toLocaleString()},ago(row.timestamp)):ago(row.timestamp))))))
        :h('table.market-table',h('thead',h('tr',...['#','Holder','Balance','Share'].map((label,i)=>h('th',{scope:'col',class:i>1?'num':''},label)))),h('tbody',rows.map((row,i)=>h('tr',h('td',String(i+1)),h('td',trader(row.address)),h('td.num',compact(row.balance)),h('td.num',number(Number(row.supplyShare)*100,2)+'%')))));
      content.replaceChildren(rows.length?h('div.table-scroll',table):h('p.muted.small',selected==='trades'?'No trades yet.':'No holders yet.'),...(selected==='holders'?[h('p.meta','Wallets only: the curve, the DEX pool and the burn address are not counted. Shares use the full 1B supply.')]:[]));
    }catch{if(current===revision)content.replaceChildren(h('p.muted.small','Trades are still indexing or temporarily unavailable.'),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:load}},'Retry'));}
  }
  Promise.allSettled([fetchKind('trades'),fetchKind('holders')]).then(([t,hd])=>onCounts({trades:t.status==='fulfilled'?`${t.value.length}${t.value.length>=100?'+':''}`:null,holders:hd.status==='fulfilled'?`${hd.value.length}${hd.value.length>=50?'+':''}`:null}));
  load();return panel;
}

function tradePanel(ctx, token, { dex, solana }) {
  const q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH';
  if(ctx.state.disconnected)return h('section.panel.trade-panel',h('h2','Trade'),h('p.muted',ctx.state.walletReadError?'Your wallet connection could not read this network. Reconnect to trade; indexed market data is still available.':`Connect your wallet on ${ctx.wallet.net.name} to buy or sell ${token.symbol}. Market data remains available without connecting.`),ctx.walletButtons(ctx.wallet.net,{onDone:()=>ctx.refresh(),onError:e=>toast(errorText(e),{kind:'error'})}));
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
    tabs.querySelectorAll('button').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.side === side)); b.tabIndex = b.dataset.side === side ? 0 : -1; });
    form?.querySelector('label[for=trade-amount]')?.replaceChildren(side === 'buy' ? 'Pay' : 'Sell');
    unit.textContent = side === 'buy' ? q : token.symbol;
    submit.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`;
    submit.className = `btn btn-block btn-lg ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`;
    amount.value = ''; out.textContent = 'Enter an amount'; fee.textContent = '—'; feeNote.textContent = ''; error.textContent = '';
    const qb = quoteBalance();
    balance.textContent = side === 'buy' ? (qb ? `Available: ${qb}` : '') : `Available: ${number(token.balance, 4)} ${token.symbol}`;
    // 25/50/75/Max of the spendable balance. Buys keep a small native reserve for network fees.
    const decimals = side === 'buy' ? (token.pair === 'native' ? (solana ? 9 : 18) : (token.quoteDecimals ?? 18)) : (token.decimals ?? 18);
    const available = side === 'buy' ? (token.pair === 'native' ? ctx.state.nativeBalance : Object.entries(ctx.state.pairBalances ?? {}).find(([k]) => k.toLowerCase() === String(token.quoteAddress).toLowerCase())?.[1] ?? null) : token.balance;
    const gasReserve = side === 'buy' && token.pair === 'native' ? (solana ? 0.02 : 0.0005) : 0;
    const toUnits = text => { const [w, f = ''] = String(text ?? '0').split('.'); return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f.slice(0, decimals) || '0').padEnd(decimals, '0')); };
    const fromUnits = n => `${n / 10n ** BigInt(decimals)}.${(n % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')}`.replace(/\.?0+$/, '') || '0';
    const presets = [...(available != null && Number(available) > gasReserve ? [25, 50, 75, 100] : []), ...(side === 'buy' && !token.complete && token.remainingBuy ? ['curve'] : [])];
    shortcuts.replaceChildren(...presets.map(value => h('button.chip-btn', { type: 'button', 'aria-label': value === 'curve' ? 'Fill the amount that completes the curve' : `${value === 100 ? 'Maximum' : value + '%'} of your balance`, on: { click: () => {
      if (value === 'curve') amount.value = token.remainingBuy;
      else {
        // Integer arithmetic so Max never exceeds the actual balance.
        const spendable = toUnits(available) - toUnits(String(gasReserve));
        amount.value = fromUnits((spendable > 0n ? spendable : 0n) * BigInt(value) / 100n);
        if (side === 'buy' && remaining && exceedsRemaining(amount.value, token.remainingBuy)) amount.value = token.remainingBuy;
      }
      quote();
    } } }, value === 'curve' ? 'Complete curve' : value === 100 ? 'Max' : `${value}%`)));
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
    h('div.pay-box', h('label', { for: 'trade-amount' }, side === 'buy' ? 'Pay' : 'Sell'), h('div.pay-input', amount, unit), shortcuts, balance),
    remainingHint, useRemaining,
    h('div.receive', h('span', 'You receive'), out),
    h('div.trade-meta', h('span', 'Trading fee'), fee),
    h('div.trade-meta', h('label', { for: 'trade-slippage' }, 'Slippage'), slippage),
    feeNote, error, submit);
  form.querySelector('label[for=trade-amount]').dataset.dynamic = 'true';
  tabs.addEventListener('click', () => { form.querySelector('label[for=trade-amount]').textContent = side === 'buy' ? 'Pay' : 'Sell'; });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setSide(event.key === 'Home' ? 'buy' : event.key === 'End' ? 'sell' : side === 'buy' ? 'sell' : 'buy');
    tabs.querySelector(`[data-side=${side}]`).focus();
  });
  setSide('buy');
  return h('section.panel.trade-panel', { 'aria-labelledby': 'trade-title' }, h('h2#trade-title.visually-hidden', 'Trade'),
    h('p.small.muted', token.graduated ? `Trades on the locked ${dex} pool since graduation.` : 'Trades on the bonding curve. Each trade pays 1.25%.'),
    form);
}
