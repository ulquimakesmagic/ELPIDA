import { nowSeconds } from './clock.mjs';
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
import {tokenWalletImage,watchEvmToken} from './wallet-token.mjs';
import {holderChat} from './holder-chat.mjs';
import {filterTrades} from './trade-filter.mjs';
import {odometer} from './odometer.mjs';
import {filterByWho,topTraders,safetyChecks,quickAmounts,walletHolders} from './token-insights.mjs';
export { exceedsRemaining };

const metadataRequests = new Map();


function dexName(ctx, token) {
  if (token.venue) return token.venue;
  if (token.dex) return token.dex;
  return ctx.mode === 'local' ? (ctx.config.dex ? 'Uniswap v3' : 'test') : ctx.wallet.dex?.name ?? 'test';
}

/** "3m ago" style relative age, used by the header and the trades table. */
export function ago(seconds) {
  const s = Math.max(0, Math.floor(nowSeconds() - seconds));
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
  const launchHash = token.launchHash ?? token.hash ?? null;
  const txUrl = hash => explorer && hash ? `${explorer}/tx/${hash}${solana && ctx.wallet.net.cluster !== 'mainnet' ? `?cluster=${ctx.wallet.net.cluster}` : ''}` : null;
  const created = toSeconds(token.created);
  const isCreator = a => a && token.creator && a.toLowerCase() === token.creator.toLowerCase();
  const external = (href, label) => href ? h('a.icon-link', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, title: label }, icon('external-link', 'icon-sm')) : null;
  const social = token.metadata ?? {};

  const priceSource=usdRate(token)===null?`USD conversion unavailable or stale; values shown in ${q}.`:`USD estimate · ${token.usdReference.source??'Price reference'} · updated ${new Date(token.usdReference.updatedAt*1000).toLocaleTimeString()}`;
  const pill=(href,label,glyph)=>h('a.tk-pill',{href,target:'_blank',rel:'noopener noreferrer',title:label},icon(glyph,'icon-sm'),label);
  const linkPills=[['website','Website','globe'],['twitter','X','at-sign'],['telegram','Telegram','send'],['discord','Discord','message-circle']].filter(([k])=>social[k]).map(([k,label,glyph])=>pill(social[k],label,glyph));
  const explorerHref=token.url??addressUrl(token.address);
  const description=social.description||'';
  const descText=h('p.tk-desc',{id:'tk-desc','data-clamped':description.length>150?'true':'false'},description||'The creator has not added a description.');
  const descMore=description.length>150?h('button.link-button',{type:'button','aria-controls':'tk-desc','aria-expanded':'false',on:{click:e=>{const open=descText.dataset.clamped==='true';descText.dataset.clamped=open?'false':'true';e.currentTarget.setAttribute('aria-expanded',String(open));e.currentTarget.textContent=open?'less':'more';}}},'more'):null;
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

  const stat = (label, value, cls = '') => h(`div.tk-stat${cls}`, h('span', label), value);
  const holdersValue = h('strong', '—'), tradesValue = h('strong', token.trades24h != null ? number(token.trades24h, 0) : '—'),volumeValue=h('strong',token.volume24h!=null?fmtValue(token.volume24h,token):'—');
  const creatorFeesTotal=h('strong','Loading…');
  const creatorFeesStat=h('section.tk-card.tk-fees',{'aria-label':'Creator fees',title:'Lifetime creator fees, including claimed amounts. LP fees include collected and currently collectible fees. Assets are shown separately.'},h('h2.tk-h','Creator fees'),creatorFeesTotal,h('p.hint','Lifetime total, including amounts already claimed.'),h('a.btn.btn-secondary.btn-sm',{href:'#/rewards'},'Claim fees',icon('arrow-right','icon-sm')));
  const tile=(label,value,title)=>h('div.tk-tile',{title:title??null},h('span',label),h('strong',value));
  const details = h('section.tk-card.tk-details', { 'aria-label': 'Token details' }, h('h2.tk-h', 'Token details'), h('div.tk-tiles',
    tile('Liquidity',fmtValue(Number(token.reserve??0),token),'Actual quote assets in the curve or pool; virtual reserves are excluded.'),
    tile('Supply', compact(token.supply || 1e9)),
    tile('Trading pair', q),
    tile('Venue', token.graduated ? (dex === 'test' ? 'Locked test pool' : dex) : 'Bonding curve')));
  const miniBar = (label, value) => h('div.tk-dev-row', h('span', label), h('strong', value == null ? '—' : `${number(value, 2)}%`), h('span.tk-minibar', { 'aria-hidden': 'true' }, h('i')));
  const devCard = token.devBoughtPct != null ? h('section.tk-card.tk-dev', { 'aria-label': 'Dev transparency', title: devLabel(token.devBoughtPct, token.devHoldingPct) }, h('h2.tk-h', 'Dev transparency'), miniBar('Dev bought', token.devBoughtPct), miniBar('Dev holds now', token.devHoldingPct)) : null;
  if (devCard) devCard.querySelectorAll('.tk-minibar i').forEach((fill, i) => { const v = Number([token.devBoughtPct, token.devHoldingPct][i]); fill.style.width = `${Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0))}%`; });

  const change = token.priceChange24h, hasChange = change && Number.isFinite(change.percent), up = hasChange && change.percent >= 0;
  const usdOn = usdRate(token) !== null;
  const buys = token.buys24h, sells = token.sells24h;
  const tile2 = (label, value, cls = '', title = null) => h(`div.tk-strip-tile${cls}`, { title }, h('span', label), value);
  const changePill = hasChange ? h(`span.pct-pill.${up ? 'pct-up' : 'pct-down'}`, { title: change.basis ?? '24h change' }, `${up ? '+' : ''}${number(change.percent, 2)}%`) : null;
  const txValue = h('strong', buys != null && sells != null ? [String(number(Number(buys) + Number(sells), 0)), ' ', h('small', h('span.up', `${number(buys, 0)} buys`), ' · ', h('span.down', `${number(sells, 0)} sells`))] : (token.trades24h != null ? number(token.trades24h, 0) : '—'));
  const strip = h('section.tk-strip', { 'aria-label': 'Market numbers' },
    tile2(usdOn ? 'Price' : `Price in ${q}`, h('div.tk-strip-price', odometer(fmtPrice(token), 'tk-price-value'), changePill)),
    tile2('Market cap', h('strong.tk-accent', fmtValue(p.marketCap, token)), '.tk-strip-cap', 'Price × total supply (1B)'),
    tile2('Liquidity', h('strong', fmtValue(Number(token.reserve ?? 0), token)), '', 'Actual quote assets in the curve or pool; virtual reserves are excluded.'),
    tile2('24h volume', volumeValue),
    tile2('Holders', holdersValue),
    tile2('24h trades', txValue, '', 'Indexed trades in the last 24 hours'));
  const head = h('header.tk-head',
    h('nav.tk-crumb', { 'aria-label': 'Breadcrumb' }, h('a', { href: '#/' }, icon('arrow-left', 'icon-sm'), 'Explore'), h('span', { 'aria-hidden': 'true' }, '/'), h('span.tk-crumb-now', token.symbol),
      h('span.tk-chain', { title: ctx.envLabel() }, chainIcon(token.network ?? ctx.wallet.net.key), h('span', ctx.envLabel()))),
    h('div.tk-id', h('span.tk-avatar', avatar(token, 'avatar-lg'), h('span.tk-avatar-chain', { title: ctx.envLabel() }, chainIcon(token.network ?? ctx.wallet.net.key))),
      h('div.tk-id-copy', h('h1', { title: token.name }, token.name),
        h('div.tk-tags',
          h('span.tk-tag.tk-tag-strong', '$' + token.symbol),
          h('span.tk-tag', { title: `Trading pair: ${q}` }, assetIcon(q), q),
          created ? h('span.tk-tag', { title: new Date(created * 1000).toLocaleString() }, `Launched ${ago(created)} ago`) : null,
          token.creator ? h('a.tk-tag.tk-creator', { href: addressUrl(token.creator) ?? '#', target: '_blank', rel: 'noopener noreferrer', title: `Creator: ${token.creator}` }, 'by ', h('span.mono', short(token.creator)), h('span.badge-dev', 'Dev')) : null,
          h('span.tk-tag.tk-addr', { title: token.address }, short(token.address), copyButton(token.address, '')),
          h('span.tk-tag', { title: 'Copy a link that shows a preview card on X, Telegram and Discord' }, 'Share', copyButton(`${location.origin}/token/${encodeURIComponent(token.network ?? ctx.wallet.net.key)}/${token.address}`, '')),
          token.graduated ? h('span.tk-tag.tk-tag-live', dex === 'test' ? 'Graduated' : `On ${dex}`) : null),
        h('div.tk-links', ...linkPills, explorerHref ? h('a.tk-pill.tk-pill-end', { href: explorerHref, target: '_blank', rel: 'noopener noreferrer', title: 'Open in explorer' }, 'Explorer', icon('arrow-up-right', 'icon-sm')) : null, txUrl(launchHash) ? h('a.tk-pill', { href: txUrl(launchHash), target: '_blank', rel: 'noopener noreferrer', title: 'The transaction that created this token' }, 'Launch transaction', icon('arrow-up-right', 'icon-sm')) : null))),
    h('div.tk-about', descText, descMore),
    token.metadataURI ? h('p.tk-lock', icon('lock', 'icon-xs'), 'Details are recorded at launch and cannot be edited.') : null);
  const chart = terminalChart(ctx, token, q);
  const priceCard = h('section.tk-card.tk-pricecard', { 'aria-label': 'Chart' }, chart, h('p.tk-foot', priceSource));

  const addresses = h('section.address-row', { 'aria-label': 'Contract addresses and dates' },
    h('div', h('span', 'Token'), h('a', { href: addressUrl(token.address) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.address))),
    token.curve ? h('div', h('span', 'Curve'), h('a', { href: addressUrl(token.curve) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.curve))) : null,
    token.pool && !/^0x0+$/.test(token.pool) && token.graduated ? h('div', h('span', 'Pool'), h('a', { href: addressUrl(token.pool) ?? '#', target: '_blank', rel: 'noopener noreferrer' }, short(token.pool))) : null,
    created ? h('div', h('span', 'Launched'), h('strong', new Date(created * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))) : null,
    token.graduated && toSeconds(token.completedAt ?? token.graduatedAt) ? h('div', h('span', 'Graduated'), h('strong', new Date(toSeconds(token.completedAt ?? token.graduatedAt) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))) : null);

  const about = h('section.about', { 'aria-labelledby': 'about-title' }, h('h2#about-title', 'About'),
    h('p.section-text', token.metadata?.description || 'The creator has not added a description.'),
    token.metadataURI ? h('p.small.muted', token.metadataStatus === 'unavailable' ? 'Published metadata is temporarily unavailable.' : 'Metadata reference recorded on-chain.') : null);
  if(ctx.mode==='testnet'&&!solana){
    const walletToken={...token,network:ctx.wallet.net.key};
    const image=tokenWalletImage(walletToken,location.origin);
    const status=h('p.small.muted',{role:'status','aria-live':'polite'});
    const add=h('button.btn.btn-secondary.btn-sm',{type:'button',disabled:!ctx.wallet.address,on:{click:async()=>{
      add.disabled=true;status.textContent='Waiting for your wallet…';
      try{
        const result=await withWalletTimeout(watchEvmToken({provider:ctx.wallet.eth,chainId:ctx.wallet.net.chainId,token:walletToken,origin:location.origin}),ctx.wallet.walletName);
        status.textContent=result.status==='added'?'Wallet accepted the token request. Image display depends on the wallet.':result.status==='unsupported'?'This wallet does not support adding tokens by request. Its own token-data service controls discovery and logos.':'Token request cancelled or not accepted.';
      }catch(e){status.textContent=errorText(e);}finally{add.disabled=false;}
    }}},icon('wallet','icon-sm'),'Add to wallet');
    about.append(h('details',h('summary','Wallet logo and token metadata'),
      h('p.small.muted',image?'A public logo URL is available. Wallets decide whether to use it.':'No public logo is available yet. Publish the token image before requesting wallet display.'),
      image?h('a.link',{href:image,target:'_blank',rel:'noopener noreferrer'},'Open token image'):null,
      h('p',h('a.link',{href:'/api/wallet-tokenlist.json?network='+encodeURIComponent(ctx.wallet.net.key),target:'_blank',rel:'noopener noreferrer'},'Open this network’s token list')),
      h('p.small.muted','Phantom may use its own data providers. Publishing here does not guarantee a logo or a verified badge. Testnet indexing can differ from mainnet.'),
      add,!ctx.wallet.address?h('p.hint','Connect an EVM wallet to request adding this token.'):null,status));
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
  const page=h('div.tk-page', head,
    h('div.tk-layout',
      h('div.tk-top', priceCard),
      h('aside.tk-rail.stack', tradePanel(ctx, token, { dex, solana }), desk.position, curve, creatorFeesStat, devCard),
      h('div.tk-rest.stack', activity, details, addresses, about, tech)));
  async function loadCreatorFees(){if(!page.isConnected)return;try{const result=await ctx.api(`creator-fees?network=${encodeURIComponent(token.network??ctx.currentChain())}&token=${encodeURIComponent(token.address)}`);if(!page.isConnected)return;if(result.status==='ready'){creatorFeesTotal.textContent=result.assets.filter(a=>Number(a.amount)>0).map(a=>`${number(a.amount,6)} ${a.symbol}`).join(' + ')||`0 ${q}`;creatorFeesStat.title=`Lifetime creator fees through indexed block ${result.indexedBlock}, including claimed amounts. Token and quote assets are shown separately.`;}else{creatorFeesTotal.textContent=result.status==='loading'?'Loading…':'Unavailable';}}catch{creatorFeesTotal.textContent='Unavailable';}if(page.isConnected)setTimeout(loadCreatorFees,15000);}
  queueMicrotask(loadCreatorFees);
  return page;
}

function marketActivity(ctx,token,q,{addressUrl,isCreator,onCounts}){
  const content=h('div',h('p.muted.small','Loading trades…')),total=h('span.meta'),tabs=h('div.tk-tabs',{role:'tablist','aria-label':'Token activity'});
  let selected='trades',revision=0,side='all',chatView=null,shown=20,counts={trades:null,holders:null};
  const sideFilter=h('label.trade-side-filter',h('span','Show'),h('select.select',{'aria-label':'Filter trades by side',on:{change:event=>{side=event.target.value;shown=20;load();}}},...['all','buy','sell'].map(value=>h('option',{value},value==='all'?'All trades':value==='buy'?'Buys':'Sells'))));
  const panel=h('section.tk-card.tk-records',h('div.tk-records-head',tabs,h('div.activity-controls',sideFilter,total)),content);
  const base=ctx.mode==='local'?`tokens/${token.address}`:`public/tokens/${token.address}`,net=ctx.mode==='local'?'':`?network=${encodeURIComponent(ctx.currentChain())}`;
  const fetchKind=kind=>ctx.api(`${base}/${kind}${net}`);
  const usd=usdRate(token);
  const priceCell=row=>{const price=Number(row.quoteAmount)/Number(row.tokenAmount);return Number.isFinite(price)&&price>0?(usd!==null?formatPrice(price*usd):`${formatPrice(price,'')} ${q}`):'—';};
  const amountCell=row=>{const v=Number(row.quoteAmount);if(!Number.isFinite(v))return '—';if(usd===null)return `${number(v,v<0.001?6:3)} ${q}`;const d=v*usd;return d>0&&d<0.01?'<$0.01':'$'+number(d,2);};
  const trader=a=>h('span.trader',h('a.tk-trader',{href:addressUrl(a)??'#',target:'_blank',rel:'noopener noreferrer'},short(a),icon('arrow-up-right','icon-xs')),isCreator(a)?h('span.badge-dev',{title:'The creator of this token'},'Dev'):null);
  const role=a=>{const x=String(a??'').toLowerCase();if(isCreator(a))return 'Creator';if(token.curve&&x===token.curve.toLowerCase())return 'Curve';if(token.pool&&x===String(token.pool).toLowerCase())return 'Liquidity pool';if(/^0x0{40}$|^0x0{36}dead$/.test(x))return 'Burn';return null;};
  const label=kind=>kind==='trades'?'Activity':kind==='holders'?'Holders':'Chat';
  function drawTabs(){tabs.replaceChildren(...['trades','holders','chat'].map(kind=>h('button',{type:'button',role:'tab','aria-selected':String(selected===kind),on:{click:()=>{selected=kind;shown=20;load();}}},label(kind),counts[kind]!=null&&kind!=='chat'?h('span.tk-count',String(counts[kind])):null)));}
  async function load(){const current=++revision;
    chatView?.dispose();chatView=null;drawTabs();
    sideFilter.hidden=selected!=='trades';total.textContent='';
    if(selected==='chat'){chatView=holderChat(ctx,token);content.replaceChildren(chatView.element);return;}
    try{const fetched=await fetchKind(selected);if(current!==revision||!panel.isConnected)return;
      const all=selected==='trades'?filterTrades(fetched,side):fetched,rows=all.slice(0,shown);
      total.textContent=selected==='trades'?`${all.length} of ${fetched.length}${fetched.length>=100?'+':''} recent trades`:`${all.length}${all.length>=50?'+':''} holders`;
      const sym=token.symbol;
      const table=selected==='trades'
        ?h('table.market-table.tk-table',h('thead',h('tr',...['Time','Type',sym,'Amount','Trader','Price'].map((l,i)=>h('th',{scope:'col',class:i===0||i===1||i===4?'':'num'},l)))),h('tbody',rows.map(row=>h('tr',{class:'tk-row'},
            h('td.tk-time',row.hash&&addressUrl(row.account)?h('a',{href:addressUrl(row.account).replace(/\/address\/[^?]+/,'/tx/'+row.hash),target:'_blank',rel:'noopener noreferrer',title:new Date(row.timestamp*1000).toLocaleString()},ago(row.timestamp)+' ago'):ago(row.timestamp)+' ago'),
            h('td',h(`span.tk-badge.tk-${row.side==='buy'?'buy':'sell'}`,row.side==='buy'?'Buy':'Sell')),
            h('td.num',compact(row.tokenAmount)),h('td.num',amountCell(row)),h('td',trader(row.account)),h('td.num',priceCell(row))))))
        :h('table.market-table.tk-table',h('thead',h('tr',...['#','Holder','Balance','Share'].map((l,i)=>h('th',{scope:'col',class:i>1?'num':''},l)))),h('tbody',rows.map((row,i)=>{const share=Number(row.supplyShare)*100,r=role(row.address);return h('tr',{class:'tk-row'},h('td',String(i+1)),h('td',trader(row.address),r?h('span.tk-role',r):null),h('td.num',compact(row.balance)),h('td.num.tk-share',h('span',number(share,2)+'%'),h('span.tk-minibar',{'aria-hidden':'true'},h('i'))));})));
      if(selected==='holders')rows.forEach((row,i)=>{const fill=table.querySelectorAll('.tk-minibar i')[i];if(fill)fill.style.width=`${Math.min(100,Math.max(1,Number(row.supplyShare)*400))}%`;});
      const more=all.length>rows.length?h('button.btn.btn-secondary.btn-sm.tk-more',{type:'button',on:{click:()=>{shown+=20;load();}}},selected==='trades'?'Show more trades':'Show more holders'):null;
      content.replaceChildren(...[rows.length?h('div.table-scroll',table):h('p.muted.small',selected==='trades'?(side==='all'?'No trades yet.':`No ${side==='buy'?'buys':'sells'} in the recent indexed trades.`):'No holders yet.'),more,...(selected==='holders'?[h('p.meta','Wallets only: the curve, the DEX pool and the burn address are not counted. Shares use the full 1B supply.')]:[])].filter(Boolean));
    }catch{if(current===revision)content.replaceChildren(h('p.muted.small','Trades are still indexing or temporarily unavailable.'),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:load}},'Retry'));}
  }
  Promise.allSettled([fetchKind('trades'),fetchKind('holders')]).then(([t,hd])=>{const f=r=>r.status==='fulfilled'?r.value:null,tr=f(t),ho=f(hd);counts={trades:tr?`${tr.length}${tr.length>=100?'+':''}`:null,holders:ho?`${ho.length}${ho.length>=50?'+':''}`:null};onCounts({trades:counts.trades,holders:counts.holders});if(panel.isConnected)drawTabs();});
  load();return panel;
}

function tradePanel(ctx, token, { dex, solana }) {
  const q = token.quoteSymbol ?? ctx.state?.nativeSymbol ?? 'ETH';
  if(ctx.state.disconnected && !(token.complete && !token.graduated))return h('section.panel.trade-panel',h('h2','Trade'),h('p.muted',ctx.state.walletReadError?'Your wallet connection could not read this network. Reconnect to trade; indexed market data is still available.':`Connect your wallet on ${ctx.wallet.net.name} to buy or sell ${token.symbol}. Market data remains available without connecting.`),ctx.walletButtons(ctx.wallet.net,{onDone:()=>ctx.refresh(),onError:e=>toast(errorText(e),{kind:'error'})}));
  // A migrated Solana token trades here too, through its locked PumpSwap pool (solana-wallet pumpSwapTrade).
  if (token.complete && !token.graduated) {
    const error = h('p.error-text', { role: 'alert' });
    const label = token.dex === 'PumpSwap' ? 'Migrate to PumpSwap' : `Graduate to ${dex === 'test' ? 'a locked test pool' : dex}`;
    // Model 10 escape hatch: if graduation keeps failing for 24 h, anyone can reopen the curve for trading.
    const reopenAt = Number(token.reopenableAt) || null, canReopen = reopenAt && nowSeconds() >= reopenAt;
    const reopenNote = reopenAt ? h('p.small.muted', canReopen ? 'Graduation has not happened within 24 hours of completion, so anyone can reopen the curve and every holder can trade again.' : `If graduation keeps failing, anyone can reopen the curve for trading from ${new Date(reopenAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`) : null;
    const reopen = canReopen ? h('button.btn.btn-secondary.btn-block', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run('reopen', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, 'Reopen curve trading') : null;
    const automatic = token.network === 'base-sepolia';
    const progress = h('p.muted', {role:'status'}, automatic ? 'Checking automatic graduation…' : `Curve trading has stopped. ${label} to open the DEX pool. ${solana ? 'You advance about 0.05 SOL of account rent; the unused part is refunded in the same transaction.' : 'You pay the network fee.'}`);
    if(automatic)fetch('/api/graduation/status').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(s=>{
      progress.textContent = token.factory && s.factory && token.factory.toLowerCase() !== s.factory.toLowerCase() ? 'This legacy token is outside the automatic graduation service. Manual graduation remains available below.' : !s.enabled ? 'Automatic graduation is awaiting operator setup. No further purchase is needed.' : s.reason === 'needs_gas' || s.reason === 'daily_budget' ? 'Graduation is waiting for the operator to replenish its gas budget. No payment is required from you.' : s.state === 'retrying' || s.reason ? 'Automatic graduation encountered a delay. The operator will retry; no payment is required from you.' : 'Graduation is processed automatically. Elpida pays the network fee; no action is required from you.';
    }).catch(()=>{progress.textContent='Graduation status is temporarily unavailable. No further purchase is needed.';});
    const manual = h('button.btn.btn-secondary.btn-block', { type: 'button', 'data-busy-disable': '', on: { click: async () => { error.textContent = ''; try { await ctx.run('graduate', { token: token.address }); } catch (e) { error.textContent = errorText(e); } } } }, label);
    return h('section.panel.trade-panel', h('h2', automatic ? 'Graduation pending' : 'Curve complete'), progress,
      automatic ? h('details',h('summary.small.muted','Manual fallback'),h('p.small.muted','Optional: submit graduation yourself and pay network gas.'),manual) : manual, reopenNote, reopen, error);
  }
  let side = 'buy', revision = 0, timer, quoteReady = false, submitting = false;
  const amount = h('input.input#trade-amount', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0.00', required: true, 'aria-describedby': 'trade-balance' });
  const unit = h('span.affix');
  const balance = h('p.hint#trade-balance');
  const shortcuts = h('div.shortcuts', { role: 'group', 'aria-label': 'Amount shortcuts' });
  const out = h('strong', 'Enter an amount'), fee = h('strong', '—'), minOut = h('strong', '—'), feeNote = h('p.hint');
  // Live anti-snipe countdown ("Launch fee window: 47% → 1.25% in 31 s") while the first minute lasts.
  const feeWindow = h('p.hint.fee-window', { role: 'status', 'aria-live': 'off' });
  let feeTicks = 0;
  const tickFeeWindow = () => {
    const label = token.launchedAt && !token.complete && !token.graduated ? snipeLabel(token.launchedAt, nowSeconds(), token.feeSchedule ?? {}) : null;
    feeWindow.textContent = label ?? ''; feeWindow.hidden = !label;
    if (label) {
      feeTicks++;
      // Refresh an entered quote every 5 s while the fee falls; stop once the panel leaves the page.
      if (feeTicks % 5 === 0 && Number(amount.value) > 0) quote();
      if (feeTicks < 3 || feeWindow.isConnected) setTimeout(tickFeeWindow, 1000);
    } else if (feeTicks) { feeTicks = 0; if (Number(amount.value) > 0) quote(); }
  };

  const error = h('p.error-text', { role: 'alert' });
  const slippage = h('select.select#trade-slippage', [['0.1', '0.1%'], ['0.5', '0.5%'], ['1', '1%'], ['3', '3%'], ['5', '5%']].map(([v, l]) => h('option', { value: v, selected: v === '1' }, l)));
  const submit = h('button.btn.btn-block.btn-lg', { type: 'submit', disabled:true });
  const updateSubmit = () => { submit.disabled = !quoteReady || submitting; };
  const remainingDisplay = token.remainingBase ?? token.remainingBuy;
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
    amount.value = ''; out.textContent = 'Enter an amount'; fee.textContent = '—'; minOut.textContent = '—'; feeNote.textContent = ''; error.textContent = '';
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
    if (!(Number(value) > 0)) { out.textContent = 'Enter an amount'; fee.textContent = '—'; minOut.textContent = '—'; feeNote.textContent = ''; return; }
    // A curve reopened after its graduation grace is fully sold: selling works, buying resumes once a holder sells.
    if (side === 'buy' && token.soldOut && !token.complete && !token.graduated) {
      out.textContent = 'Nothing left to buy'; fee.textContent = '—'; minOut.textContent = '—'; feeNote.textContent = '';
      error.textContent = 'Every curve token is sold. This curve was reopened after graduation did not happen, so holders can sell now; buying resumes as soon as someone sells.';
      return;
    }
    if (side === 'buy' && remaining && exceedsRemaining(value,token.remainingBuy) && !solana && !token.partialFill) {
      out.textContent = 'Amount exceeds the curve limit'; fee.textContent = '—'; minOut.textContent = '—'; feeNote.textContent = '';
      error.textContent = `About ${number(token.remainingBuy,8)} ${q} remains on the bonding curve. Use the remaining-amount button to fill the exact limit, then graduate to the locked pool.`;
      useRemaining.hidden = false; return;
    }
    fee.textContent = '—'; minOut.textContent = '—'; feeNote.textContent = '';
    out.textContent = 'Getting quote…';
    timer = setTimeout(async () => {
      try {
        const result = ctx.mode === 'local' ? await ctx.api('quote', { token: token.address, side, amount: value }) : await ctx.wallet.getQuote({ token: token.address, side, amount: value });
        if (rev !== revision) return;
        quoteReady = true; updateSubmit();
        out.textContent = `${number(result.out, side === 'buy' ? 2 : 6)} ${side === 'buy' ? token.symbol : q}`;
        fee.textContent = `${number(result.fee, 6)} ${result.feeSymbol ?? q}`;
        minOut.textContent = `${number(Number(result.out) * (1 - Number(slippage.value) / 100), side === 'buy' ? 2 : 6)} ${side === 'buy' ? token.symbol : q}`;
        feeNote.textContent = result.antiSnipeActive ? `Launch protection is active: the fee is ${number(result.feeBps / 100, 2)}% right now and falls to 1.25% by the end of the first minute. The amount above 1.25% is added to the token's locked liquidity.` : result.completesCurve ? `This purchase completes the curve. Only ${number(result.spend, 4)} ${q} will be charged.` : '';
      } catch (e) { if (rev !== revision) return; out.textContent = 'Quote unavailable'; fee.textContent = '—'; minOut.textContent = '—'; error.textContent = errorText(e); }
    }, 300);
  }
  amount.addEventListener('input', quote);
  slippage.addEventListener('change', () => { if (Number(amount.value) > 0) quote(); });
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
    h('div.trade-meta', h('span', 'Minimum received'), minOut),
    h('details.trade-settings', h('summary', icon('sliders-horizontal', 'icon-sm'), 'Slippage settings'), h('div.trade-meta', h('label', { for: 'trade-slippage' }, 'Slippage tolerance'), slippage)),
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
  return h('section.panel.trade-panel.tk-trade', { 'aria-labelledby': 'trade-title' }, h('h2#trade-title.visually-hidden', 'Trade'),
    h('p.small.muted', token.tax ? `Buy tax ${token.tax.buyBps/100}% / sell tax ${token.tax.sellBps/100}%, fixed at launch. Tax revenue: 30% Elpida / 70% creator allocations. ${token.graduated?'The V2 pool fee is additional; the curve fee has stopped. LP fees compound in locked liquidity. Creator tax claims are paid in this token.':'The 1.25% curve fee remains additional, split 50/50. First-minute protection adds locked liquidity.'}` : token.graduated ? `Trading on ${dex === 'test' ? 'the locked test pool' : dex}. Liquidity is locked permanently. The curve fee has stopped; the DEX pool fee applies.${token.venue === 'PumpSwap' ? ' LP fees are harvested 50/50 to Elpida and the creator.' : ''}` : 'Trades on the bonding curve. Each trade pays 1.25%, plus a higher launch-protection fee during the first minute.'),
    form);
}
