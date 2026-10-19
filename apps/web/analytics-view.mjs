import {h,icon,number,compact,short} from './ui.mjs';

export function renderAnalytics({api}){
  let period='7d',network='all',metric='volumeUsd',revision=0,data=null;
  const root=h('div.analytics-page'), body=h('div.analytics-body'), status=h('p.small.muted',{'role':'status'});
  const periods=h('div.analytics-filters',{'aria-label':'Analytics period'},['24h','7d','30d','all'].map(p=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(p===period),on:{click:()=>{period=p;for(const b of periods.children)b.setAttribute('aria-pressed',b.dataset.period===p);load();}},'data-period':p},p==='all'?'All time':p)));
  const chain=h('select',{ 'aria-label':'Analytics chain',on:{change:()=>{network=chain.value;load();}}},h('option',{value:'all'},'All chains'));
  const refresh=h('button.round-button.analytics-refresh',{type:'button','aria-label':'Refresh analytics',title:'Refresh',on:{click:load}},icon('refresh-cw','icon-sm'));
  root.append(h('div.page-head',h('div',h('p.an-eyebrow',icon('chart-column','icon-sm'),'Analytics · public protocol data'),h('h1','Explore the numbers'),h('p.muted','Launches, markets and fees across Elpida networks. No wallet required.')),h('div.analytics-controls',periods,chain,refresh)),status,body);
  const usd=v=>'$'+number(v), metricCard=(title,value,note,glyph,hl)=>h('div.tile.analytics-metric',{'data-hl':hl?'true':null},h('p.an-tile-label',icon(glyph,'icon-sm'),title),h('strong',value),h('p.small.muted',note));
  function chart(){
    const values=data.series.map(b=>b[metric]),max=Math.max(1,...values),plot=h('div.analytics-plot');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 900 220');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${metric==='volumeUsd'?'Trading volume in reference USD':metric} over the selected period`);
    for(let i=0;i<4;i++){const l=document.createElementNS(svg.namespaceURI,'line');for(const [k,v]of Object.entries({x1:0,x2:900,y1:20+i*60,y2:20+i*60}))l.setAttribute(k,v);l.setAttribute('class','analytics-gridline');svg.append(l);}
    const pts=values.map((v,i)=>`${values.length===1?450:i/(values.length-1)*900},${200-v/max*180}`),area=document.createElementNS(svg.namespaceURI,'polygon');area.setAttribute('points',`${values.length===1?450:0},200 ${pts.join(' ')} ${values.length===1?450:900},200`);area.setAttribute('class','analytics-area');svg.append(area);const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',values.map((v,i)=>`${values.length===1?450:i/(values.length-1)*900},${200-v/max*180}`).join(' '));line.setAttribute('class','analytics-line');svg.append(line);plot.append(svg);
    const date=t=>new Date(t*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',...(period==='24h'?{hour:'numeric'}:{})});
    plot.append(h('div.analytics-axis',h('span',date(data.series[0].timestamp)),h('span',`Peak ${metric==='volumeUsd'?usd(Math.max(0,...values)):number(Math.max(0,...values))}`),h('span',date(data.series.at(-1).timestamp))));
    return plot;
  }
  function table(headers,rows){return h('div.analytics-table-scroll',h('table.analytics-table',h('thead',h('tr',headers.map(t=>h('th',{scope:'col'},t)))),h('tbody',rows.length?rows:h('tr',h('td',{colSpan:headers.length},'No indexed activity in this period.')))));}
  function draw(){
    const t=data.totals;
    const tabs=h('div.analytics-filters',['volumeUsd','trades','launches'].map(m=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(m===metric),on:{click:()=>{metric=m;draw();}}},m==='volumeUsd'?'Volume':m==='trades'?'Trades':'Launches')));
    const pairs=data.assets.filter(a=>a.trades).sort((a,b)=>b.volumeUsd-a.volumeUsd||b.trades-a.trades);
    const coverage=data.coverage.map(c=>h('div.analytics-coverage-row',h('div',h('strong',c.name),h('p.small.muted',c.enabled?c.lastSuccess?`Last indexed ${new Date(c.lastSuccess).toLocaleString()}`:'Waiting for first sync':'Deployment not configured'),c.scope?h('p.small.muted',c.scope):null),h('span.badge',c.error?'Sync delayed':!c.enabled?'Not indexed':c.lastSuccess?'Indexing':'Starting')));
    body.replaceChildren(
      h('div.analytics-metrics',metricCard('Trading volume',usd(t.volumeUsd),'Current USD reference · selected period','trending-up',true),metricCard('Trades',number(t.trades),'Buys and sells · selected period','arrow-down-up'),metricCard('Tokens launched',number(t.launches),'Selected period','sparkles'),metricCard('Trading addresses',number(t.addresses),'Unique per chain · may include routers','users')),
      h('section.panel.analytics-chart',h('div.analytics-section-head',h('div',h('h2','Protocol activity'),h('p.small.muted',`${t.tokens} indexed tokens · ${t.graduated} graduated · all time`)),tabs),chart(),t.trades===0?h('p.small.muted','No trades recorded for this period.'):null),
      h('div.analytics-columns',h('section.panel',h('h2','Volume by trading pair'),pairs.length?pairs.map(a=>h('div.analytics-pair',h('div',h('strong',a.symbol),h('p.small.muted',a.chain)),h('div',h('strong',`${number(a.volume,6)} ${a.symbol}`),h('p.small.muted',`${a.priced?usd(a.volumeUsd):'USD price unavailable'} · ${number(a.trades)} trades`)))):h('p.muted','No pair activity yet.')),h('section.panel',h('h2','Indexer coverage'),coverage)),
      h('section.panel',h('h2','Top tokens'),h('p.small.muted','Ranked by reference USD volume, then trade count.'),table(['Token','Chain','Volume','Trades'],data.topTokens.filter(r=>r.trades).map(r=>h('tr',h('td',h('a',{href:`#/token/${r.address}?network=${encodeURIComponent(r.network)}`},r.name||short(r.address)),h('p.small.muted',r.symbol??'')),h('td',r.chain),h('td',r.priced?usd(r.volumeUsd):`${number(r.volume,6)} ${r.quoteSymbol}`),h('td',number(r.trades)))))) ,
      h('section.panel',h('h2','Reserves & unclaimed fees'),h('p.small.muted','Current indexed balances across all time. Fees below are outstanding claims, not cumulative revenue. Uncollected DEX position fees are excluded.'),table(['Chain / asset','Trading reserve','Creator fees','Protocol fees'],data.assets.map(a=>h('tr',h('td',`${a.chain} · ${a.symbol}`),...['reserve','creatorFees','protocolFees'].map(k=>h('td',`${number(a[k],8)} ${a.symbol}`)))))) ,
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
