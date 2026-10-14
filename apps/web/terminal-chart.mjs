import {h,number,usdRate} from './ui.mjs';
const preferences=new Map();
export function terminalChart(ctx,token,q){
 const key=`${ctx.currentChain()}:${token.address}`,pref=preferences.get(key)??{basis:'cap',interval:60,style:'candles'};if(preferences.size>100)preferences.delete(preferences.keys().next().value);preferences.set(key,pref);
 const controls=h('div.chart-controls'),plot=h('div.terminal-chart',{'aria-label':'Interactive executed-trade chart',role:'img'}),status=h('p.small.muted',{role:'status'}),readout=h('p.chart-readout');
 const panel=h('section.panel.price-history',h('div.chart-top',h('strong','Market history'),controls),readout,plot,status,h('p.chart-credit',h('a',{href:'https://www.tradingview.com/',target:'_blank',rel:'noopener noreferrer'},'Charts by TradingView'), ' · Lightweight Charts™ · Copyright © 2026 TradingView, Inc.'));
 let chart,observer,revision=0;
 function cleanup(){if(chart)pref.range=chart.timeScale().getVisibleRange();observer?.disconnect();chart?.remove();chart=null;}
 const lifecycle=new MutationObserver(()=>{if(!panel.isConnected){cleanup();lifecycle.disconnect();}});
 function buttons(label,values,current,update){return h('div.chart-options',{role:'group','aria-label':label},values.map(([v,t])=>h('button.btn.btn-secondary.btn-sm',{type:'button','aria-pressed':String(v===current),on:{click:()=>{update(v);pref.range=null;draw();load();}}},t)));}
 function draw(){controls.replaceChildren(buttons('Chart value',[['cap','Market cap'],['price','Price']],pref.basis,v=>pref.basis=v),buttons('Chart style',[['candles','Candles'],['line','Line']],pref.style,v=>pref.style=v),buttons('Chart interval',[[60,'1m'],[300,'5m'],[3600,'1h'],[86400,'1D']],pref.interval,v=>pref.interval=v));}
 async function load(){const request=++revision;status.textContent='Loading executed trades…';
  try{const net=ctx.mode==='local'?'':`&network=${encodeURIComponent(ctx.currentChain())}`,base=ctx.mode==='local'?'tokens':'public/tokens',rows=await ctx.api(`${base}/${token.address}/candles?interval=${pref.interval}${net}`);if(request!==revision||!panel.isConnected)return;
   cleanup();plot.replaceChildren();const points=rows.filter(p=>Number.isSafeInteger(p.timestamp)&&Number(p.close)>0&&[p.open,p.high,p.low,p.close].every(v=>Number.isFinite(Number(v)))).sort((a,b)=>a.timestamp-b.timestamp);
   if(!points.length){status.textContent='No executed trades yet. Candles appear after the first trade.';return;}const library=window.LightweightCharts;if(!library)throw new Error('Chart library could not load.');
   const rate=usdRate(token),scale=(pref.basis==='cap'?Number(token.supply??1e9):1)*(rate??1),unit=rate===null?q:'USD',data=points.map(p=>({time:p.timestamp,open:Number(p.open)*scale,high:Number(p.high)*scale,low:Number(p.low)*scale,close:Number(p.close)*scale}));
   chart=library.createChart(plot,{width:plot.clientWidth,height:plot.clientHeight||420,layout:{background:{color:'#0c120e'},textColor:'#a9b9ad',attributionLogo:true},grid:{vertLines:{color:'#1b2820'},horzLines:{color:'#1b2820'}},timeScale:{timeVisible:true,secondsVisible:false},rightPriceScale:{borderColor:'#26372c'},crosshair:{mode:library.CrosshairMode.Normal}});
   const formatter=v=>(rate===null?'':'$')+number(v,v<0.01?8:v<1?4:2),priceFormat={type:'custom',formatter,minMove:pref.basis==='cap'?0.01:Math.max(1e-12,Number(token.spotPrice??0)*scale/1000)};
   const candles=chart.addSeries(pref.style==='candles'?library.CandlestickSeries:library.LineSeries,pref.style==='candles'?{upColor:'#74ef9a',downColor:'#ff778c',borderVisible:false,wickUpColor:'#74ef9a',wickDownColor:'#ff778c',priceFormat}:{color:'#74ef9a',lineWidth:2,pointMarkersVisible:true,priceFormat});candles.setData(pref.style==='candles'?data:data.map(p=>({time:p.time,value:p.close})));
   const volume=chart.addSeries(library.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:0.83,bottom:0}});volume.setData(points.map((p,i)=>({time:p.timestamp,value:Number(p.tokenVolumeRaw??0)/10**(ctx.wallet===ctx.solWallet?6:18),color:data[i].close>=data[i].open?'#235f39':'#632c36'})));
   if(pref.range)chart.timeScale().setVisibleRange(pref.range);else chart.timeScale().fitContent();const keyForReadout=p=>{readout.textContent=`${pref.basis==='cap'?'Market cap':'Price'} · O ${formatter(p.open)}  H ${formatter(p.high)}  L ${formatter(p.low)}  C ${formatter(p.close)} ${unit}`;};keyForReadout(data.at(-1));chart.subscribeCrosshairMove(p=>{const value=p.seriesData.get(candles);if(value&&'open'in value)keyForReadout(value);});
   observer=new ResizeObserver(()=>chart?.applyOptions({width:plot.clientWidth,height:plot.clientHeight}));observer.observe(plot);lifecycle.observe(document.body,{childList:true,subtree:true});
   status.textContent=`Executed-trade history · ${unit}. ${points.length===1?'One trade bucket; more trades will build the chart.':''} ${rate===null?'USD reference unavailable.':'Historical candles use the current USD reference, not historical exchange rates.'} Scroll to zoom; drag to pan.`;
  }catch(e){if(request===revision){cleanup();status.replaceChildren(document.createTextNode('Chart unavailable. '),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:load}},'Retry'));}}
 }
 draw();load();return panel;
}
