import {h,icon,number,compact,short,avatar} from './ui.mjs';

export function renderAnalytics({api}){
  let period='7d',network='all',metric='volumeUsd',revision=0,data=null;
  const root=h('div.analytics-page'), body=h('div.analytics-body'), status=h('p.small.muted',{'role':'status'});
  const periods=h('div.analytics-filters',{'aria-label':'Analytics period'},['24h','7d','30d','all'].map(p=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(p===period),on:{click:()=>{period=p;for(const b of periods.children)b.setAttribute('aria-pressed',b.dataset.period===p);load();}},'data-period':p},p==='all'?'All time':p)));
  const chain=h('select',{ 'aria-label':'Analytics chain',on:{change:()=>{network=chain.value;load();}}},h('option',{value:'all'},'All chains'));
  const refresh=h('button.round-button.analytics-refresh',{type:'button','aria-label':'Refresh analytics',title:'Refresh',on:{click:load}},icon('refresh-cw','icon-sm'));
  root.append(h('div.page-head',h('div',h('p.an-eyebrow',icon('chart-column','icon-sm'),'Analytics · public protocol data'),h('h1','Analytics'),h('p.muted','Launches, markets and fees across Elpida networks. No wallet required.')),h('div.analytics-controls',periods,chain,refresh)),status,body);
  const usd=v=>'$'+compact(v), metricCard=(title,value,note,glyph,hl)=>h('div.tile.analytics-metric',{'data-hl':hl?'true':null},h('p.an-tile-label',icon(glyph,'icon-sm'),title),h('strong',value),h('p.small.muted',note));
  function chart(){
    const values=data.series.map(b=>b[metric]),max=Math.max(1,...values),plot=h('div.analytics-plot');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 900 220');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${metric.endsWith('Usd')?'Trading volume in reference USD':metric} over the selected period`);
    for(let i=0;i<4;i++){const l=document.createElementNS(svg.namespaceURI,'line');for(const [k,v]of Object.entries({x1:0,x2:900,y1:20+i*60,y2:20+i*60}))l.setAttribute(k,v);l.setAttribute('class','analytics-gridline');svg.append(l);}
    const pts=values.map((v,i)=>`${values.length===1?450:i/(values.length-1)*900},${200-v/max*180}`),area=document.createElementNS(svg.namespaceURI,'polygon');area.setAttribute('points',`${values.length===1?450:0},200 ${pts.join(' ')} ${values.length===1?450:900},200`);area.setAttribute('class','analytics-area');svg.append(area);const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',values.map((v,i)=>`${values.length===1?450:i/(values.length-1)*900},${200-v/max*180}`).join(' '));line.setAttribute('class','analytics-line');svg.append(line);plot.append(svg);
    const date=t=>new Date(t*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',...(period==='24h'?{hour:'numeric'}:{})});
    plot.append(h('div.analytics-axis',h('span',date(data.series[0].timestamp)),h('span',`Peak ${metric.endsWith('Usd')?usd(Math.max(0,...values)):number(Math.max(0,...values))}`),h('span',date(data.series.at(-1).timestamp))));
    return plot;
  }
  function table(headers,rows,empty='No indexed activity in this period.'){return h('div.analytics-table-scroll',h('table.analytics-table',h('thead',h('tr',headers.map(t=>h('th',{scope:'col'},t)))),h('tbody',rows.length?rows:h('tr',h('td',{colSpan:headers.length},empty)))));}
  function draw(){
    const t=data.totals;
    const tabs=h('div.analytics-filters',['volumeUsd','stockVolumeUsd','trades','launches'].map(m=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(m===metric),on:{click:()=>{metric=m;draw();}}},m==='volumeUsd'?'Volume':m==='stockVolumeUsd'?'Stock volume':m==='trades'?'Trades':'Launches')));
    const pairs=data.assets.filter(a=>a.trades).sort((a,b)=>b.volumeUsd-a.volumeUsd||b.trades-a.trades);
    const stockPairs=data.assets.filter(a=>a.pair==='xstock');
    const tokenCell=r=>h('a.analytics-token',{href:`#/token/${r.address}?network=${encodeURIComponent(r.network)}`},avatar(r,'analytics-avatar'),h('span',r.name||r.symbol||short(r.address),h('span.small.muted',r.symbol?` $${r.symbol}`:'')));
    const coverage=data.coverage.map(c=>h('div.analytics-coverage-row',h('div',h('strong',c.name),h('p.small.muted',c.enabled?c.lastSuccess?`Last indexed ${new Date(c.lastSuccess).toLocaleString()}`:'Waiting for first sync':'Deployment not configured'),c.scope?h('p.small.muted',c.scope):null),h('span.badge',c.error?'Sync delayed':!c.enabled?'Not indexed':c.lastSuccess?'Indexing':'Starting')));
    body.replaceChildren(
      h('div.analytics-metrics',metricCard('Trading volume',usd(t.volumeUsd),'Current USD reference · selected period','trending-up',true),metricCard('Trades',number(t.trades),'Buys and sells · selected period','arrow-down-up'),metricCard('Tokens launched',number(t.launches),'Selected period','sparkles'),metricCard('Trading addresses',number(t.addresses),'Unique per chain · may include routers','users')),
      h('section.panel.analytics-chart',h('div.analytics-section-head',h('div',h('h2','Protocol activity'),h('p.small.muted',`${number(t.tokens)} indexed tokens · ${number(t.graduated)} graduated · ${number(t.creators)} creators · all time`)),tabs),chart(),t.trades===0?h('p.small.muted','No trades recorded for this period.'):null),
      h('section.panel',h('div.analytics-section-head',h('h2','Trading overview'),h('span.badge','Selected period')),
        h('div.analytics-summary',metricCard('Average trade',t.averageTradeUsd===null?'—':usd(t.averageTradeUsd),'Trades with a fresh USD reference','arrow-down-up'),metricCard('Buys / sells',`${number(t.buys)} / ${number(t.sells)}`,'Confirmed trade sides','trending-up'),metricCard('Stock-pair volume',usd(t.stockVolumeUsd),t.stockVolumeShare===null?'No priced volume':`${number(t.stockVolumeShare*100)}% of priced volume`,'chart-column'),metricCard('Stock-pair launches',number(t.stockLaunches),'Selected period','sparkles')),
        table(['Trading venue','USD volume','Trades'],(data.venues??[]).map(v=>h('tr',h('td',v.venue==='curve'?'Bonding curves':v.venue==='dexPool'?'Graduated DEX pools':'Other / unspecified'),h('td',usd(v.volumeUsd),v.unpricedTrades?h('p.small.muted',`${v.unpricedTrades} unpriced trades excluded`):null),h('td',number(v.trades)))))),
      h('section.panel',h('div.analytics-section-head',h('div',h('h2','Top creators'),h('p.small.muted','Ranked by their tokens’ selected-period USD trading volume. Missing prices make totals partial. Wallet identities stay separate per chain.'))),
        table(['#','Creator','Chain','Volume','Trades','Launches'],(data.topCreators??[]).map((c,i)=>h('tr',h('td',String(i+1)),h('td',h('a.mono',{href:`#/?q=${encodeURIComponent(c.creator)}&chain=${encodeURIComponent(c.network)}`,title:c.creator},short(c.creator))),h('td',c.chain),h('td',usd(c.volumeUsd),c.unpricedTrades?h('p.small.muted','Partial USD coverage'):null),h('td',number(c.trades)),h('td',number(c.launches)))),'No indexed creator activity in this period.')),
      h('section.panel',h('h2','Tokenized-stock pairs'),h('p.small.muted','Elpida activity in stock-paired launches. These figures do not measure the issuer’s total stock-token market.'),
        table(['Pair asset','Chain','Launches','USD volume','Trades'],stockPairs.map(a=>h('tr',h('td',a.symbol),h('td',a.chain),h('td',number(a.launches)),h('td',a.priced?usd(a.volumeUsd):'USD unavailable'),h('td',number(a.trades)))),'No indexed tokenized-stock pairs.')),
      h('div.analytics-columns',h('section.panel',h('h2','Volume by trading pair'),pairs.length?pairs.map(a=>h('div.analytics-pair',h('div',h('strong',a.symbol),h('p.small.muted',a.chain)),h('div',h('strong',`${number(a.volume,6)} ${a.symbol}`),h('p.small.muted',`${a.priced?usd(a.volumeUsd):'USD price unavailable'} · ${number(a.trades)} trades`)))):h('p.muted','No pair activity yet.')),h('section.panel',h('h2','Indexer coverage'),coverage)),
      h('section.panel',h('h2','Top tokens'),h('p.small.muted','Ranked by reference USD volume, then trade count.'),table(['Token','Chain','Volume','Trades'],data.topTokens.filter(r=>r.trades).map(r=>h('tr',h('td',tokenCell(r)),h('td',r.chain),h('td',r.priced?usd(r.volumeUsd):'USD unavailable'),h('td',number(r.trades)))))) ,
      h('section.panel',h('h2','Recent graduations'),h('p.small.muted','Tokens whose curve completed, newest first. All time, not limited to the period above.'),table(['Token','Chain','Graduated'],(data.graduations??[]).map(g=>h('tr',h('td',h('a',{href:`#/token/${g.address}?network=${encodeURIComponent(g.network)}`},g.name||g.symbol),h('span.small.muted',` $${g.symbol}`)),h('td',g.chain),h('td',new Date(g.graduatedAt*1000).toLocaleDateString()))),'No tokens have graduated yet.')),
      h('section.panel',h('h2','Reserves & unclaimed fees'),h('p.small.muted','Current indexed balances across all time. Fees below are outstanding claims, not cumulative revenue. Uncollected DEX position fees are excluded.'),table(['Chain / asset','Trading reserve','Creator fees','Protocol fees'],data.assets.map(a=>h('tr',h('td',`${a.chain} · ${a.symbol}`),...['reserve','creatorFees','protocolFees'].map(k=>h('td',`${number(a[k],8)} ${a.symbol}`)))))) ,
      h('section.panel.analytics-flywheel',h('div.analytics-section-head',h('h2','Revenue flywheel'),h('span.badge','Planned · execution disabled')),
        h('p','10% of received Elpida protocol fees is earmarked in the proposed design for buybacks and burns of up to ten eligible Elpida tokens, ranked by market capitalization.'),
        h('div.analytics-policy',h('div',h('strong','10%'),h('span','Received protocol fees')),h('div',h('strong','Top 10'),h('span','Eligible tokens by market cap')),h('div',h('strong','Buy & burn'),h('span','Verified execution required'))),
        h('p.small.muted','Creator fees and locked liquidity are excluded. Existing partner buyback allocations come first. Received-revenue and burn accounting are not connected to this page yet; no budget, spend or burn totals are claimed here.')),
      h('section.analytics-notes',h('h3','About these figures'),h('p.small.muted',data.basis),h('p.small.muted',`${t.unpricedTrades} trades have no verified USD reference. Testnet tokens have no monetary value. Local simulations are excluded. Chains without configured indexers are shown above and excluded from totals.`)));
  }
  async function load(){
    const id=++revision;refresh.disabled=true;body.setAttribute('aria-busy','true');status.textContent='Updating public analytics…';
    try{const next=await api(`public/analytics?period=${period}&network=${encodeURIComponent(network)}`);if(id!==revision)return;data=next;
      if(chain.options.length===1)for(const c of data.coverage)chain.append(h('option',{value:c.key},c.name));
      status.textContent=`Updated ${new Date(data.updatedAt*1000).toLocaleString()} · confirmed indexed activity`;draw();
    }catch(e){if(id!==revision)return;status.textContent=`Analytics unavailable. ${e.message} Use Refresh to retry.`;if(!data)body.replaceChildren(h('div.panel',h('h2','Unable to load analytics'),h('p','The indexer may be starting or temporarily unavailable.')));}
    finally{if(id===revision){refresh.disabled=false;body.setAttribute('aria-busy','false');}}
  }
  const timer=setInterval(()=>{if(root.isConnected&&!document.hidden)load();},30000);
  load();return {root,dispose:()=>clearInterval(timer)};
}
