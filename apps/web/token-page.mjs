import { snipeLabel, devLabel } from '/curve-model.mjs';
import { assetIcon, chainIcon } from './chain-ui.mjs';
import { usdcFunding } from './usdc-funding.mjs';
// Token detail page: market figures with plain definitions, bonding-curve progress, trade panel,
// graduation actions, creator-fee summary and technical details.
import { h, icon, short, number, compact, avatar, pricing, fmtPrice, fmtValue, progressOf, lifecycle, copyButton, errorText, toast, usdRate, formatPrice, bar } from './ui.mjs';
import { withWalletTimeout, walletErrorText } from './wallet.mjs';
import { exceedsRemaining } from './amounts.mjs';
import {terminalChart} from './terminal-chart.mjs';
import {holderTerminal} from './holder-terminal.mjs';
export { exceedsRemaining };

const metadataRequests = new Map();


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

  const priceSource=usdRate(token)===null?`USD conversion unavailable or stale; values shown in ${q}.`:`USD estimate · ${token.usdReference.source??'Price reference'} · updated ${new Date(token.usdReference.updatedAt*1000).toLocaleTimeString()}`;
  const byline=h('div.terminal-byline',created?h('span',{title:new Date(created*1000).toLocaleString()},ago(created)):null,
    h('span.chain-context',{title:ctx.envLabel(),'aria-label':ctx.envLabel()},chainIcon(token.network??ctx.wallet.net.key)),
    h('span.chain-context',{title:`Trading pair: ${q}`,'aria-label':`Trading pair: ${q}`},assetIcon(q)),
    token.creator?h('a.icon-link',{href:addressUrl(token.creator)??'#',target:'_blank',rel:'noopener noreferrer',title:`Creator ${token.creator}`,'aria-label':`Creator ${short(token.creator)}`},icon('wallet','icon-sm')):null,
    copyButton(token.address,''),external(token.url??addressUrl(token.address),'Open token in explorer'),
    ...[['twitter','X','at-sign'],['telegram','Telegram','send'],['website','Website','globe'],['discord','Discord','message-circle']].filter(([k])=>social[k]).map(([k,label,glyph])=>h('a.icon-link',{href:social[k],target:'_blank',rel:'noopener noreferrer',title:label,'aria-label':label},icon(glyph,'icon-sm'))));
  // Curve progress: real reserve raised toward the reserve that completes the curve (net of the fee).
  // Model 10 shows the cost at the 1.25% base fee: during the first minute the anti-snipe fee would inflate it.
  const remainingDisplay = token.remainingBase ?? token.remainingBuy;
  const reserve = Number(token.reserve || 0), remainingNet = Number(remainingDisplay || 0) * (1 - 0.0125);
  const target = reserve + remainingNet, raisedPct = token.complete || token.graduated ? 100 : target > 0 ? reserve / target * 100 : pct;
  const curve = h('section.curve-strip', { 'aria-label': 'Bonding curve progress' },
    h('div.curve-line', h('span', token.graduated ? `Graduated to ${dex === 'test' ? 'a locked test pool' : dex}` : token.complete ? 'Curve complete · ready to graduate' : 'Curve'),
      h('span.meta', token.graduated ? 'Liquidity locked permanently' : target > 0 ? `${number(raisedPct, raisedPct < 1 ? 2 : 1)}% of ${number(target, 2)} ${q}` : `${number(pct, 1)}% sold`)),
    bar(raisedPct, token.complete || token.graduated, 'Bonding curve progress'),
    !token.graduated ? h('p.small.muted', token.complete ? `Anyone can graduate it: the ${number(reserve, 4)} ${q} reserve and the remaining tokens open a ${dex} pool with permanently locked liquidity.` : `Virtual bonding curve: purchases build the reserve. About ${number(remainingDisplay, 4)} ${q} more completes it, then the liquidity moves into a locked ${dex} pool.`) : null);

  const stat = (label, value, extra) => h('div.stat', h('span', label), h('strong', value), extra ?? null);
  const holdersValue = h('strong', '—'), tradesValue = h('strong', '—'),volumeValue=h('strong','—');
  const creatorFees = Number(token.creatorFees || 0);
  const stats = h('section.stat-row', { 'aria-label': 'Token statistics' },
    stat('Market cap',fmtValue(p.marketCap,token)),
    stat('Price',fmtPrice(token)),
    h('div.stat',{title:'Actual quote assets in the curve or pool; virtual reserves are excluded.'},h('span','Liquidity'),h('strong',fmtValue(Number(token.reserve??0),token))),
    h('div.stat',h('span','24h volume'),volumeValue),
    stat('Supply', compact(token.supply || 1e9)),
    // Creator transparency: there is no cap on the creator's first buy, so show what they bought and hold now.
    token.devBoughtPct != null ? h('div.stat.dev-stat', { title: devLabel(token.devBoughtPct, token.devHoldingPct) }, h('span', 'Dev'), h('strong', `${number(token.devBoughtPct, 2)}% → ${token.devHoldingPct != null ? number(token.devHoldingPct, 2) + '%' : '—'}`)) : null,
    token.graduated || creatorFees > 0
      ? stat('Creator unclaimed', usdRate(token) !== null ? '$' + number(creatorFees * usdRate(token), 2) : `${number(creatorFees, 6)} ${q}`, h('a.terminal-claim', { href: '#/rewards',title:'Claim creator fees','aria-label':'Claim creator fees' },icon('arrow-right','icon-sm')))
      : stat('Creator fee', '0.625%', null));

  stats.title=priceSource;
  const head=h('header.token-terminal-bar',
    h('div.terminal-identity',avatar(token,'avatar-lg'),h('div.terminal-identity-copy',h('h1',token.symbol,h('span.token-full-name',{title:token.name},token.name)),byline)),
    stats,h('details.terminal-context',h('summary',h('span.status-dot'),token.graduated?dex:life.label,icon('chevron-down','icon-sm')),
      h('div.terminal-context-popover',h('p',ctx.envLabel()),h('p',`Trading pair: ${q}`),h('p',priceSource),h('p','Market cap uses price × total supply. Calculation details are shown in Technical details.'),h('p','Holders: ',holdersValue,' · Trades: ',tradesValue))));

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
    const key=`${ctx.currentChain()}:${token.address.toLowerCase()}`;
    const request=metadataRequests.get(key) ?? {pending:false,message:''};
    metadataRequests.set(key,request);
    const status=h('p.small', {role:'status','aria-live':'polite'});
    const publish=h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:async()=>{
      if(request.pending)return;
      const update=(message,pending=true)=>{request.message=message;request.pending=pending;request.draw?.();};
      update('Preparing token details for your signature…');
      try{
        await ctx.wallet.checkNetwork();
        const body={network:ctx.currentChain(),token:token.address,metadata:token.metadata,expires:Math.floor(Date.now()/1000)+240};
        const prepared=await ctx.api('public/metadata/prepare',body);
        update(`Waiting for ${ctx.wallet.walletName}. Open its Chrome extension and sign “Elpida public token metadata”. This publishes token details only; no gas or token transfer.`);
        const signature=await withWalletTimeout(ctx.wallet.signer.signMessage(prepared.message),ctx.wallet.walletName);
        update('Signature received. Saving token details…');
        await ctx.api('public/metadata/save',{...body,signature});
        update('Token details are published for every visitor.',false);
        await ctx.refresh();
      }catch(e){update(walletErrorText(e,ctx.wallet.walletName)??errorText(e),false);}
    }}},'Publish saved token details');
    request.draw=()=>{status.textContent=request.message;publish.disabled=request.pending;publish.textContent=request.pending?'Publishing token details…':'Publish saved token details';};
    request.draw();
    about.append(h('p.small.muted','These token details are saved only in this browser. Publish them with a creator signature so every visitor sees them.'),publish,status);
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
  const desk=holderTerminal(ctx,token,{onVolume:v=>volumeValue.textContent=fmtValue(v,token)});
  return h('div.token-page', head,
    h('div.token-layout',terminalChart(ctx,token,q),h('aside.trade-aside.stack',desk.position,tradePanel(ctx, token, { dex, solana })),h('div.stack.terminal-detail',curve,activity,desk.feed,addresses,about,tech)));
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
    // Model 10 escape hatch: if graduation keeps failing for 24 h, anyone can reopen the curve for trading.
    const reopenAt = Number(token.reopenableAt) || null, canReopen = reopenAt && Date.now() / 1000 >= reopenAt;
    const reopenNote = reopenAt ? h('p.small.muted', canReopen ? 'Graduation has not happened within 24 hours of completion, so anyone can reopen the curve and every holder can trade again.' : `If graduation keeps failing, anyone can reopen the curve for trading from ${new Date(reopenAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`) : null;
    const reopen = canReopen ? h('button.btn.btn-secondary.btn-block', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run('reopen', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, 'Reopen curve trading') : null;
    return h('section.panel.trade-panel', h('h2', 'Curve complete'), h('p.muted', `Curve trading has stopped. ${label} to open the DEX pool. ${solana ? 'You advance about 0.05 SOL of account rent; the unused part is refunded in the same transaction.' : 'You pay the network fee.'}`),
      h('button.btn.btn-primary.btn-block', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run('graduate', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, label), reopenNote, reopen, error);
  }
  let side = 'buy', revision = 0, timer, quoteReady = false, submitting = false;
  const amount = h('input.input#trade-amount', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0.00', required: true, 'aria-describedby': 'trade-balance' });
  const unit = h('span.affix');
  const balance = h('p.hint#trade-balance');
  const shortcuts = h('div.shortcuts', { role: 'group', 'aria-label': 'Amount shortcuts' });
  const out = h('strong', 'Enter an amount'), fee = h('strong', '—'), feeNote = h('p.hint');
  // Live anti-snipe countdown ("Launch fee window: 47% → 1.25% in 31 s") while the first minute lasts.
  const feeWindow = h('p.hint.fee-window', { role: 'status', 'aria-live': 'off' });
  let feeTicks = 0;
  const tickFeeWindow = () => {
    const label = token.launchedAt && !token.complete && !token.graduated ? snipeLabel(token.launchedAt, Date.now() / 1000, token.feeSchedule ?? {}) : null;
    feeWindow.textContent = label ?? ''; feeWindow.hidden = !label;
    if (label) {
      feeTicks++;
      // Refresh an entered quote every 5 s while the fee falls; stop once the panel leaves the page.
      if (feeTicks % 5 === 0 && Number(amount.value) > 0) quote();
      if (feeTicks < 3 || feeWindow.isConnected) setTimeout(tickFeeWindow, 1000);
    } else if (feeTicks) { feeTicks = 0; if (Number(amount.value) > 0) quote(); }
  };

  const error = h('p.error-text', { role: 'alert' });
  const slippage = h('select.select#trade-slippage', [['0.5', '0.5%'], ['1', '1%'], ['3', '3%'], ['5', '5%']].map(([v, l]) => h('option', { value: v, selected: v === '1' }, l)));
  const submit = h('button.btn.btn-block.btn-lg', { type: 'submit', disabled:true });
  const updateSubmit = () => { submit.disabled = !quoteReady || submitting; };
  const remaining = !token.complete && !token.graduated && Number(token.remainingBuy) > 0;
  const remainingHint = h('p.hint', remaining ? `About ${number(remainingDisplay,8)} ${q} remains to complete the curve. Further trading continues after graduation into the locked pool.` : '');
  const useRemaining = h('button.btn.btn-secondary.btn-sm.curve-limit-action', {type:'button',hidden:true,on:{click:()=>{amount.value=token.remainingBuy;quote();}}}, 'Use remaining amount');
  const funding=token.pair==='native'?usdcFunding(ctx,{amount:()=>amount.value,symbol:q,context:token.address}):null;
  const tabs = h('div.segmented', { role: 'tablist', 'aria-label': 'Trade side' }, ['buy', 'sell'].map(s => h('button', { type: 'button', role: 'tab', 'data-side': s, 'aria-selected': String(s === side), on: { click: () => setSide(s) } }, s === 'buy' ? 'Buy' : 'Sell')));
  const quoteBalance = () => {
    if(token.pair === 'native') return `${number(ctx.state.nativeBalance ?? 0, 6)} ${q}`;
    const held=Object.entries(ctx.state.pairBalances??{}).find(([address])=>address.toLowerCase()===token.quoteAddress?.toLowerCase())?.[1];
    if(held!=null)return `${number(held,4)} ${q}`;
    return ctx.state.balanceSymbol===q?`${number(ctx.state.balance,4)} ${q}`:null;
  };
  function setSide(next) {
    side = next; revision++; clearTimeout(timer);
    if(funding)funding.hidden=side!=='buy';
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
    if (side === 'buy' && remaining && exceedsRemaining(value,token.remainingBuy) && !solana && !token.partialFill) {
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
        feeNote.textContent = result.antiSnipeActive ? `Launch protection is active: the fee is ${number(result.feeBps / 100, 2)}% right now and falls to 1.25% by the end of the first minute. The amount above 1.25% is added to the token's locked liquidity.` : result.completesCurve ? `This purchase completes the curve. Only ${number(result.spend, 4)} ${q} will be charged.` : '';
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
    funding,
    h('div.receive', h('span', 'You receive'), out),
    h('div.trade-meta', h('span', 'Trading fee'), fee),
    h('div.trade-meta', h('label', { for: 'trade-slippage' }, 'Slippage'), slippage),
    feeWindow, feeNote, error, submit);
  form.querySelector('label[for=trade-amount]').dataset.dynamic = 'true';
  tabs.addEventListener('click', () => { form.querySelector('label[for=trade-amount]').textContent = side === 'buy' ? 'Pay' : 'Sell'; });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setSide(event.key === 'Home' ? 'buy' : event.key === 'End' ? 'sell' : side === 'buy' ? 'sell' : 'buy');
    tabs.querySelector(`[data-side=${side}]`).focus();
  });
  setSide('buy');
  tickFeeWindow();
  return h('section.panel.trade-panel', { 'aria-labelledby': 'trade-title' }, h('h2#trade-title.visually-hidden', 'Trade'),
    h('p.small.muted', token.graduated ? `Trades on the locked ${dex} pool since graduation.` : 'Trades on the bonding curve. Each trade pays 1.25%, plus a higher launch-protection fee during the first minute.'),
    form);
}
