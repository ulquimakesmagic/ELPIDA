import {h,icon,usdRate} from './ui.mjs';
import {axisLabel,priceText,pctText,tipPosition,INTERVALS,fillGaps,defaultInterval,tradeMarkers,spacedLabels} from './chart-format.mjs';

// Token page chart, the way trading terminals draw one: candles of executed trades with volume bars underneath,
// 1s to 1D candles, price or market cap, live updates (the token page calls refresh() when a trade of this token
// streams in) and markers on the candles where the creator or the reader traded.
const preferences=new Map();
const tone=(name,fallback)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;
const alpha=(color,a)=>{
  const c=String(color).trim();
  const hex=c.match(/^#([0-9a-f]{6})/i);
  if(hex)return `#${hex[1]}${Math.round(a*255).toString(16).padStart(2,'0')}`;
  const rgb=c.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  return rgb?`rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`:c;
};
// Axis ticks in local time: year, month, day, then hours and minutes (seconds on the finest scale).
function localTick(time,type){
  const d=new Date(Number(time)*1000);
  if(type===0)return String(d.getFullYear());
  if(type===1)return d.toLocaleDateString(undefined,{month:'short'});
  if(type===2)return d.toLocaleDateString(undefined,{day:'numeric',month:'short'});
  return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',...(type===4?{second:'2-digit'}:{}),hour12:false});
}

export function terminalChart(ctx,token,q){
  const network=token.network??ctx.currentChain();
  const key=`${network}:${token.address}`;
  const pref=preferences.get(key)??{basis:'price',interval:null};
  if(preferences.size>100)preferences.delete(preferences.keys().next().value);
  preferences.set(key,pref);

  const stage=h('div.chart-stage');
  const plot=h('div.terminal-chart',{'aria-label':'Price chart of executed trades',role:'img'});
  const legend=h('div.chart-legend',{'aria-hidden':'true'});
  const tip=h('div.chart-tip',{'aria-hidden':'true',hidden:true});
  const overlay=h('div.chart-overlay',{'aria-hidden':'true'});
  const toolbar=h('div.chart-toolbar');
  const status=h('p.chart-note',{role:'status'});
  stage.append(plot,legend,tip,overlay);
  const panel=h('div.price-history',toolbar,stage,status,h('p.chart-credit',h('a',{href:'https://www.tradingview.com/',target:'_blank',rel:'noopener noreferrer'},'Charts by TradingView'),' · Lightweight Charts™ · Copyright © 2026 TradingView, Inc.'));

  let chart,candles,volume,markers,rate,scale,unit,revision=0,timer,lastSignature='',live=null;
  let current={bars:[],byTime:new Map()};
  let markRows=[],labelGap=0;
  let lastCrosshair=null;
  // A sub-cent token plots at 5e-7 and the library's tick generator fails on a span that small, so prices are drawn
  // in a scaled domain and divided back in the formatter.
  let magnitude=0;
  // Prices are never negative; the scale's bottom margin can still produce a tick below zero, which is left blank.
  const axisText=value=>Number(value)<0?'':axisLabel(Number(value)/10**magnitude);
  const me=()=>ctx.mode==='testnet'?ctx.wallet?.address:ctx.state?.wallet;

  function cleanup(){
    chart?.remove();chart=candles=volume=markers=null;
  }

  // Desktop: the chart sits beside the trade panel, so size it to end just above the fold (320–560 px).
  const wide=typeof matchMedia==='function'?matchMedia('(min-width: 1001px)'):null;
  function fitHeight(){
    if(!stage.isConnected)return;
    if(!wide?.matches){stage.style.removeProperty('height');return;}
    const top=stage.getBoundingClientRect().top+(window.scrollY||0);
    stage.style.height=`${Math.round(Math.min(560,Math.max(320,window.innerHeight-top-150)))}px`;
  }
  let fitTimer;
  const onResize=()=>{clearTimeout(fitTimer);fitTimer=setTimeout(fitHeight,120);};
  if(typeof window!=='undefined'&&window.addEventListener){window.addEventListener('resize',onResize);requestAnimationFrame?.(()=>requestAnimationFrame(fitHeight));}
  const lifecycle=new MutationObserver(()=>{if(!panel.isConnected){cleanup();clearInterval(timer);window.removeEventListener?.('resize',onResize);lifecycle.disconnect();}});

  /* ---------- toolbar: candle size and value basis ---------- */
  function segment(label,items,value,onPick){
    const pick=event=>{
      const button=event.currentTarget;
      if(button.getAttribute('aria-pressed')==='true')return;
      onPick(button.dataset.value);
      for(const sibling of button.parentElement.children)sibling.setAttribute('aria-pressed',String(sibling===button));
    };
    return h('div.chart-seg',{role:'group','aria-label':label},items.map(([v,text])=>
      h('button.chart-seg-btn',{type:'button','data-value':String(v),'aria-pressed':String(String(v)===String(value)),on:{click:pick}},text)));
  }
  function draw(){
    toolbar.replaceChildren(
      segment('Candle size',INTERVALS,pref.interval??60,v=>{pref.interval=Number(v);pref.chosen=true;lastSignature='';load({fit:true});}),
      segment('Chart value',[['price','Price'],['cap','MCap']],pref.basis,v=>{pref.basis=v;lastSignature='';load({fit:false});}));
  }

  /* ---------- chart ---------- */
  // Small dots for the reader's own trades, arrows for the creator's; the newest 60 only (30 on a phone). An arrow is
  // labelled "Dev buy"/"Dev sell" only when the nearest label on the same side is far enough away at the current zoom,
  // and never on a phone-width plot (the tooltip and the trades table still say who traded).
  function applyMarkers(){
    if(!markers||!chart)return;
    const narrow=plot.clientWidth<480;
    const ts=chart.timeScale(),range=ts.getVisibleLogicalRange();
    const spacing=range&&range.to>range.from?ts.width()/(range.to-range.from):8;
    const gap=narrow?Infinity:Math.max(1,Math.ceil(60/spacing));
    if(gap===labelGap)return;
    labelGap=gap;
    const up=tone('--candle-up','#2fd47f'),down=tone('--candle-down','#f6465d');
    const dev=spacedLabels(markRows.filter(m=>m.who==='Dev'),current.bars.map(b=>b.timestamp),gap);
    const rows=[...dev,...markRows.filter(m=>m.who!=='Dev')].sort((a,b)=>a.time-b.time);
    markers.setMarkers(rows.map(m=>({time:m.time,position:m.position,shape:m.who==='Dev'?m.shape:'circle',size:m.who==='Dev'?(narrow?0.8:1):0.55,
      color:m.side==='buy'?up:down,text:m.labelled&&gap!==Infinity?`Dev ${m.side==='buy'?'buy':'sell'}`:''})));
  }
  function build(){
    cleanup();plot.replaceChildren();
    const lib=window.LightweightCharts;
    if(!lib)return false;
    const up=tone('--candle-up','#2fd47f'),down=tone('--candle-down','#f6465d');
    const grid=tone('--line-soft','rgba(255,255,255,.086)'),cross=tone('--line-strong','rgba(255,255,255,.22)'),label=tone('--surface-3','#222C25');
    chart=lib.createChart(plot,{
      // The library follows the container's size itself (the stage is resized to fit the window).
      autoSize:true,
      layout:{background:{type:'solid',color:tone('--paper','#080B09')},textColor:tone('--ink-3','#9AAA9E'),fontFamily:getComputedStyle(document.body).fontFamily,fontSize:11,attributionLogo:false},
      grid:{vertLines:{color:grid,style:lib.LineStyle.Dotted},horzLines:{color:grid,style:lib.LineStyle.Dotted}},
      rightPriceScale:{borderVisible:false,entireTextOnly:true,minimumWidth:64,scaleMargins:{top:.1,bottom:.24}},
      timeScale:{borderVisible:false,timeVisible:true,secondsVisible:(pref.interval??60)<60,rightOffset:4,barSpacing:8,minBarSpacing:1.5,maxBarSpacing:40,tickMarkFormatter:localTick},
      crosshair:{mode:lib.CrosshairMode.Normal,vertLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:label},horzLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:label}},
      // Times in the reader's own zone, like the tooltip (the library defaults to UTC).
      localization:{priceFormatter:axisText,timeFormatter:t=>new Date(Number(t)*1000).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',...((pref.interval??60)<60?{second:'2-digit'}:{})})},
      handleScale:{axisPressedMouseMove:{time:true,price:true}},
    });
    candles=chart.addSeries(lib.CandlestickSeries,{
      upColor:up,downColor:down,borderUpColor:up,borderDownColor:down,wickUpColor:up,wickDownColor:down,
      priceLineVisible:true,lastValueVisible:true,priceLineStyle:lib.LineStyle.Dashed,
      priceFormat:{type:'custom',formatter:axisText,minMove:0.0001},
    });
    // Volume underneath, on its own scale in the bottom fifth, coloured by the candle's direction.
    volume=chart.addSeries(lib.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});
    chart.priceScale('volume').applyOptions({scaleMargins:{top:.8,bottom:0}});
    markers=typeof lib.createSeriesMarkers==='function'?lib.createSeriesMarkers(candles,[]):null;
    // Re-space the labels as the reader zooms (bar spacing changes).
    chart.timeScale().subscribeVisibleLogicalRangeChange(()=>applyMarkers());
    chart.subscribeCrosshairMove(move=>{
      lastCrosshair=move?{time:move.time??null,point:move.point?{x:Math.round(move.point.x),y:Math.round(move.point.y)}:null}:null;
      const bar=move?.time!==undefined?current.byTime.get(move.time):null;
      showLegend(bar??current.bars.at(-1));
      if(!move?.point||!bar){hideTip();return;}
      showTip(move.point,bar);
    });
    lifecycle.observe(document.body,{childList:true,subtree:true});
    return true;
  }

  const volumeText=bar=>{
    const v=quoteVolume(bar);
    if(v===null)return '—';
    return rate===null?`${priceText(v)} ${q}`:`$${priceText(v)}`;
  };
  // The legend above the candles: the hovered (or latest) candle's OHLC, change and volume.
  function showLegend(bar){
    if(!bar){legend.replaceChildren();return;}
    const s=Number(scale),change=pctText(Number(bar.open),Number(bar.close)),dir=Number(bar.close)>=Number(bar.open)?'up':'down';
    const cell=(k,v)=>h('span.chart-legend-cell',h('em',k),v);
    legend.replaceChildren(
      cell('O',priceText(Number(bar.open)*s)),cell('H',priceText(Number(bar.high)*s)),cell('L',priceText(Number(bar.low)*s)),cell('C',priceText(Number(bar.close)*s)),
      change?h('span.chart-legend-chg',{'data-dir':dir},change):null,cell('Vol',volumeText(bar)));
  }
  function showTip(point,bar){
    const s=Number(scale),cell=(k,v)=>h('span.chart-tip-cell',h('em',k),v),change=pctText(Number(bar.open),Number(bar.close));
    tip.replaceChildren(
      h('div.chart-tip-head',new Date(bar.timestamp*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...((pref.interval??60)<60?{second:'2-digit'}:{})}),change?h('span.chart-tip-chg',{'data-dir':Number(bar.close)>=Number(bar.open)?'up':'down'},change):null),
      h('div.chart-tip-grid',cell('O',priceText(Number(bar.open)*s)),cell('H',priceText(Number(bar.high)*s)),cell('L',priceText(Number(bar.low)*s)),cell('C',priceText(Number(bar.close)*s))),
      h('div.chart-tip-foot',h('span',h('em','Volume '),volumeText(bar)),h('span',h('em','Trades '),String(bar.trades??0))));
    tip.hidden=false;
    const box=stage.getBoundingClientRect();
    const at=tipPosition(point,{width:tip.offsetWidth||190,height:tip.offsetHeight||96},{width:box.width,height:box.height});
    tip.style.setProperty('transform',`translate(${at.x}px, ${at.y}px)`);
  }
  function hideTip(){if(!tip.hidden)tip.hidden=true;}

  /* ---------- data ---------- */
  const quoteVolume=bar=>{
    if(bar?.quoteVolumeRaw==null)return null;
    const value=Number(bar.quoteVolumeRaw)/10**Number(token.quoteDecimals??(ctx.wallet===ctx.solWallet?9:18));
    return rate===null?value:value*rate;
  };
  function shape(rows,interval){
    const valid=rows.filter(p=>Number.isSafeInteger(p.timestamp)&&Number(p.close)>0&&[p.open,p.high,p.low,p.close].every(v=>Number.isFinite(Number(v)))).sort((a,b)=>a.timestamp-b.timestamp);
    const bars=fillGaps(valid,interval);
    rate=usdRate(token);scale=(pref.basis==='cap'?Number(token.supply??1e9):1)*(rate??1);unit=rate===null?q:'USD';
    const lows=bars.map(p=>Number(p.low)*scale).filter(v=>v>0);
    const smallest=lows.length?Math.min(...lows):0;
    magnitude=smallest>0?Math.max(0,Math.min(12,Math.ceil(-Math.log10(smallest))+2)):0;
    const f=scale*10**magnitude;
    const up=tone('--candle-up','#2fd47f'),down=tone('--candle-down','#f6465d');
    const priceData=bars.map(p=>({time:p.timestamp,open:Number(p.open)*f,high:Number(p.high)*f,low:Number(p.low)*f,close:Number(p.close)*f}));
    const volumeData=bars.map(p=>({time:p.timestamp,value:quoteVolume(p)??0,color:alpha(Number(p.close)>=Number(p.open)?up:down,p.filled?0:.45)}));
    return {bars,priceData,volumeData,byTime:new Map(bars.map(b=>[b.timestamp,b]))};
  }
  function empty(message,sub){
    overlay.replaceChildren(h('div.chart-empty',icon('chart-candlestick','icon-lg'),h('strong',message),sub?h('span',sub):null));
    overlay.hidden=false;
  }
  const path=kind=>{
    const base=ctx.mode==='local'?`tokens/${token.address}`:`public/tokens/${token.address}`,net=ctx.mode==='local'?'':`network=${encodeURIComponent(network)}&`;
    return `${base}/${kind}?${net}`;
  };

  async function load({quiet=false,fit=true}={}){
    const request=++revision;
    if(!quiet){status.textContent='Loading executed trades…';plot.classList.add('is-loading');}
    try{
      // No choice yet: open on the finest candle size that fits the history in ~300 candles.
      if(!pref.chosen&&pref.interval==null){
        const daily=await ctx.api(`${path('candles')}interval=86400&limit=500`).catch(()=>[]);
        pref.interval=daily.length?defaultInterval(daily[0].timestamp,daily.at(-1).timestamp+86400):60;
        draw();
      }
      const interval=pref.interval??60;
      const [rows,recent]=await Promise.all([ctx.api(`${path('candles')}interval=${interval}&limit=500`),ctx.api(`${path('trades')}limit=200`).catch(()=>[])]);
      if(request!==revision||!panel.isConnected)return;
      const signature=JSON.stringify(rows.slice(-2))+rows.length+pref.basis+interval+(recent[0]?.hash??'');
      if(quiet&&signature===lastSignature&&chart)return;
      lastSignature=signature;
      plot.classList.remove('is-loading');
      const shaped=shape(rows,interval);
      if(!shaped.bars.length){
        cleanup();plot.replaceChildren();legend.replaceChildren();empty('No trades yet','Candles start with the first buy or sell.');
        status.textContent='Executed trades only. Nothing is shown until someone trades.';
        return;
      }
      if(!window.LightweightCharts)throw new Error('Chart library could not load.');
      overlay.hidden=true;
      const rebuild=!chart||chart.__interval!==interval;
      if(rebuild){build();chart.__interval=interval;}
      current=shaped;
      candles.setData(shaped.priceData);volume.setData(shaped.volumeData);
      // Small dots for the reader's own trades, labelled arrows for the creator's; the newest 60 only. On a phone-width
      // plot the labels would overlap, so the arrows go unlabelled (the tooltip and trades table still say who traded).
      markRows=tradeMarkers(recent,interval,{creator:token.creator,me:me()}).filter(m=>shaped.byTime.has(m.time)).slice(plot.clientWidth<480?-30:-60);
      labelGap=0;applyMarkers();
      if(rebuild||fit){
        // Show the latest ~120 candles, or everything when there are fewer.
        const n=shaped.priceData.length;
        if(n>120)chart.timeScale().setVisibleLogicalRange({from:n-120,to:n+4});else chart.timeScale().fitContent();
      }
      showLegend(shaped.bars.at(-1));
      const label=INTERVALS.find(([s])=>s===interval)?.[1]??`${interval}s`;
      status.textContent=`${label} candles of executed trades · ${pref.basis==='cap'?'market cap':'price'} in ${unit}. ${rate===null?'USD reference unavailable.':'USD uses the current reference rate, not historical rates.'}`;
    }catch{
      if(request===revision){
        plot.classList.remove('is-loading');
        if(!quiet||!chart){
          cleanup();
          status.replaceChildren(document.createTextNode('Chart unavailable. '),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:()=>load()}},'Retry'));
        }
      }
    }
  }

  /* ---------- hooks: live updates, tests and capture ---------- */
  // A streamed trade of this token: reload quietly (coalesced), keeping the reader's zoom and scroll.
  panel.refresh=()=>{clearTimeout(live);live=setTimeout(()=>{if(panel.isConnected)load({quiet:true,fit:false});},250);};
  panel.screenshot=()=>chart?.takeScreenshot?.()??null;
  panel.debug=()=>({basis:pref.basis,interval:pref.interval,magnitude,bars:current.bars.length,series:chart?2:0,crosshair:lastCrosshair,tip:!tip.hidden});

  draw();overlay.hidden=true;load();
  // Only the chart that is actually on screen may keep polling (a replaced view must not keep fetching).
  timer=setInterval(()=>{
    if(!panel.isConnected||document.querySelector('.price-history')!==panel){clearInterval(timer);cleanup();return;}
    if(!document.hidden)load({quiet:true,fit:false});
  },15000);
  return panel;
}
