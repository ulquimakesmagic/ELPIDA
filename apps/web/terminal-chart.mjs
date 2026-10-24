import {h,icon,number,compact,usdRate} from './ui.mjs';
// Executed-trade chart for the token page. Lightweight Charts draws it; every colour is read from the
// active theme at draw time. Data is executed trades only: no quotes, no simulated history.
const preferences=new Map();
const INTERVALS=[[60,'1m'],[300,'5m'],[900,'15m'],[3600,'1h'],[14400,'4h'],[86400,'1D']];
const tone=(name,fallback)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;
// Canvas needs an explicit alpha; theme tokens are hex or rgb(a).
function withAlpha(color,a){
 const c=String(color).trim();let m=c.match(/^#([0-9a-f]{6})/i);
 if(m)return `#${m[1]}${Math.round(a*255).toString(16).padStart(2,'0')}`;
 m=c.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);return m?`rgba(${m[1]},${m[2]},${m[3]},${a})`:c;
}
const pctText=(from,to)=>{if(!(from>0)||!Number.isFinite(to))return '';const p=(to-from)/from*100;return `${p>=0?'+':''}${p.toFixed(Math.abs(p)<10?2:1)}%`;};
export function terminalChart(ctx,token,q){
 const key=`${ctx.currentChain()}:${token.address}`,pref=preferences.get(key)??{basis:'cap',interval:60,style:'candles'};if(preferences.size>100)preferences.delete(preferences.keys().next().value);preferences.set(key,pref);
 const controls=h('div.chart-controls'),plot=h('div.terminal-chart',{'aria-label':'Interactive executed-trade chart',role:'img'}),status=h('p.chart-note',{role:'status'}),legend=h('p.chart-readout',{'aria-live':'off'});
 const overlay=h('div.chart-overlay',{'aria-hidden':'true'});
 const wrap=h('div.chart-wrap',legend,plot,overlay);
 const panel=h('div.price-history',h('div.chart-top',h('span.tk-live',{title:'Refreshes as new trades are indexed'},h('i'),'Live'),controls),wrap,status,h('p.chart-credit',h('a',{href:'https://www.tradingview.com/',target:'_blank',rel:'noopener noreferrer'},'Charts by TradingView'),' · Lightweight Charts™ · Copyright © 2026 TradingView, Inc.'));
 let chart,observer,main,vol,rate,scale,unit,formatter,revision=0,timer,lastRows='';
 const decimals=ctx.wallet===ctx.solWallet?6:18;
 function cleanup(){if(chart){try{pref.range=chart.timeScale().getVisibleRange();}catch{}}observer?.disconnect();chart?.remove();chart=main=vol=null;}
 const lifecycle=new MutationObserver(()=>{if(!panel.isConnected){cleanup();clearInterval(timer);lifecycle.disconnect();}});
 function group(label,values,current,update){return h('div.chart-options',{role:'group','aria-label':label},values.map(([v,t])=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(v===current),on:{click:()=>{update(v);pref.range=null;draw();load();}}},t)));}
 function draw(){controls.replaceChildren(
  group('Chart interval',INTERVALS,pref.interval,v=>pref.interval=v),
  h('div.chart-controls-end',group('Chart value',[['cap','Market cap'],['price','Price']],pref.basis,v=>pref.basis=v),group('Chart style',[['candles','Candles'],['area','Area']],pref.style==='line'?'area':pref.style,v=>pref.style=v),
   h('button.btn.btn-secondary.btn-sm.chart-fit',{type:'button','aria-label':'Fit chart to all data',title:'Fit to data',on:{click:()=>{pref.range=null;chart?.timeScale().fitContent();}}},'Fit')));}
 function shape(rows){
  const points=rows.filter(p=>Number.isSafeInteger(p.timestamp)&&Number(p.close)>0&&[p.open,p.high,p.low,p.close].every(v=>Number.isFinite(Number(v)))).sort((a,b)=>a.timestamp-b.timestamp);
  rate=usdRate(token);scale=(pref.basis==='cap'?Number(token.supply??1e9):1)*(rate??1);unit=rate===null?q:'USD';
  const data=points.map(p=>({time:p.timestamp,open:Number(p.open)*scale,high:Number(p.high)*scale,low:Number(p.low)*scale,close:Number(p.close)*scale}));
  return {points,data};
 }
 function showLegend(bar,volume){
  if(!bar){legend.replaceChildren();return;}
  const up=bar.close>=bar.open,chg=pctText(bar.open,bar.close);
  const cell=(k,v)=>h('span.cr-cell',h('em',k),v);
  legend.replaceChildren(h('span.cr-basis',pref.basis==='cap'?'Market cap':'Price'),cell('O',formatter(bar.open)),cell('H',formatter(bar.high)),cell('L',formatter(bar.low)),cell('C',formatter(bar.close)),chg?h('span.cr-chg',{'data-dir':up?'up':'down'},chg):null,h('span.cr-unit',unit),volume!==undefined?cell('Vol',`${compact(volume)} ${token.metadata?.symbol??token.symbol??''}`.trim()):null);
 }
 function empty(message,sub){overlay.replaceChildren(h('div.chart-empty',icon('chart-candlestick','icon-lg'),h('strong',message),sub?h('span',sub):null));overlay.hidden=false;}
 function paint(points,data){
  const up=tone('--up','#76ed9a'),down=tone('--down','#ffa1a1');
  const priceFormat={type:'custom',formatter,minMove:pref.basis==='cap'?0.01:Math.max(1e-12,Number(token.spotPrice??0)*scale/1000)};
  if(!main){
   const lib=window.LightweightCharts;
   chart=lib.createChart(plot,{width:plot.clientWidth,height:plot.clientHeight||380,
    layout:{background:{color:'transparent'},textColor:tone('--muted','#929298'),fontFamily:getComputedStyle(document.body).fontFamily,fontSize:11,attributionLogo:true},
    grid:{vertLines:{visible:false},horzLines:{color:tone('--line-faint','rgba(255,255,255,.06)')}},
    timeScale:{timeVisible:true,secondsVisible:false,borderVisible:false,rightOffset:4,barSpacing:9,minBarSpacing:2},
    rightPriceScale:{borderVisible:false,scaleMargins:{top:.1,bottom:.26}},
    crosshair:{mode:lib.CrosshairMode.Normal,vertLine:{color:tone('--line-strong','rgba(255,255,255,.3)'),style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--panel-3','#2a2a30')},horzLine:{color:tone('--line-strong','rgba(255,255,255,.3)'),style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--panel-3','#2a2a30')}}});
   main=chart.addSeries(pref.style==='candles'?lib.CandlestickSeries:lib.AreaSeries,pref.style==='candles'
    ?{upColor:up,downColor:down,borderVisible:false,wickUpColor:up,wickDownColor:down,priceFormat}
    :{lineColor:up,topColor:withAlpha(up,.28),bottomColor:withAlpha(up,0),lineWidth:2,crosshairMarkerRadius:4,priceFormat});
   vol=chart.addSeries(lib.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});
   vol.priceScale().applyOptions({scaleMargins:{top:.84,bottom:0}});
   chart.subscribeCrosshairMove(p=>{const bar=p.seriesData?.get(main);if(!bar){showLegend(current.data.at(-1),current.vol.at(-1));return;}
    const full=pref.style==='candles'?bar:current.data.find(d=>d.time===p.time);const v=current.points.find(d=>d.timestamp===p.time);showLegend(full??current.data.at(-1),v?Number(v.tokenVolumeRaw??0)/10**decimals:undefined);});
   observer=new ResizeObserver(()=>chart?.applyOptions({width:plot.clientWidth,height:plot.clientHeight}));observer.observe(plot);lifecycle.observe(document.body,{childList:true,subtree:true});
  }
  const volumes=points.map(p=>Number(p.tokenVolumeRaw??0)/10**decimals);
  current={points,data,vol:volumes};
  main.setData(pref.style==='candles'?data:data.map(p=>({time:p.time,value:p.close})));
  vol.setData(points.map((p,i)=>({time:p.timestamp,value:volumes[i],color:withAlpha(data[i].close>=data[i].open?up:down,.4)})));
  showLegend(data.at(-1),volumes.at(-1));
 }
 let current={points:[],data:[],vol:[]};
 async function load(quiet=false){const request=++revision;if(!quiet){status.textContent='Loading executed trades…';plot.classList.add('is-loading');}
  try{const net=ctx.mode==='local'?'':`&network=${encodeURIComponent(ctx.currentChain())}`,base=ctx.mode==='local'?'tokens':'public/tokens',rows=await ctx.api(`${base}/${token.address}/candles?interval=${pref.interval}${net}`);if(request!==revision||!panel.isConnected)return;
   const sig=JSON.stringify(rows.slice(-3))+rows.length+pref.basis+pref.style+pref.interval;if(quiet&&sig===lastRows&&chart)return;lastRows=sig;
   plot.classList.remove('is-loading');const {points,data}=shape(rows);
   if(!points.length){cleanup();plot.replaceChildren();legend.replaceChildren();empty('No trades yet','The chart starts with the first buy or sell.');status.textContent='Executed trades only. Nothing is shown until someone trades.';return;}
   if(!window.LightweightCharts)throw new Error('Chart library could not load.');
   overlay.hidden=true;
   const money=rate===null?'':'$';formatter=v=>money+number(v,v<0.01?8:v<1?4:2);
   if(!quiet||!chart){cleanup();plot.replaceChildren();}
   paint(points,data);
   if(!quiet){if(pref.range)chart.timeScale().setVisibleRange(pref.range);else chart.timeScale().fitContent();}
   status.textContent=`Executed trades only · ${unit}${points.length===1?' · one bucket so far; the chart builds as trades arrive':''}. ${rate===null?'USD reference unavailable.':'USD uses the current reference rate, not historical rates.'} Scroll to zoom, drag to pan.`;
  }catch(e){if(request===revision){plot.classList.remove('is-loading');if(!quiet||!chart){cleanup();status.replaceChildren(document.createTextNode('Chart unavailable. '),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:()=>load()}},'Retry'));}}}
 }
 draw();overlay.hidden=true;load();
 timer=setInterval(()=>{if(panel.isConnected&&!document.hidden)load(true);},20000);
 return panel;
}
