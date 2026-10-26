import {h,icon,compact,usdRate} from './ui.mjs';
import {axisLabel,priceText,pctText,tipPosition,tipFields} from './chart-format.mjs';
import {tradeMarkers} from './token-insights.mjs';

// Executed-trade chart for the token page.
//
// Structure follows the reference set: one clean row of controls (range, style, markers), candles or a line over a
// gradient, volume in its own pane below, a dotted grid, the last price pinned to the axis, and a tooltip that follows
// the crosshair instead of a permanent legend eating the plot area.
const preferences=new Map();
// Bucket size doubles as the visible window: fewer, wider bars is what a sparse testnet token needs.
const RANGES=[[60,'1m'],[300,'5m'],[3600,'1h'],[14400,'6h'],[86400,'All']];
const tone=(name,fallback)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;
const alpha=(color,a)=>{
  const c=String(color).trim();
  const hex=c.match(/^#([0-9a-f]{6})/i);
  if(hex)return `#${hex[1]}${Math.round(a*255).toString(16).padStart(2,'0')}`;
  const rgb=c.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  return rgb?`rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`:c;
};

export function terminalChart(ctx,token,q){
  const key=`${ctx.currentChain()}:${token.address}`;
  const pref=preferences.get(key)??{basis:'price',interval:3600,style:null,dev:false,mine:false};
  if(preferences.size>100)preferences.delete(preferences.keys().next().value);
  preferences.set(key,pref);

  const stage=h('div.chart-stage');
  const plot=h('div.terminal-chart',{'aria-label':'Executed-trade chart',role:'img'});
  const tip=h('div.chart-tip',{'aria-hidden':'true',hidden:true});
  const overlay=h('div.chart-overlay',{'aria-hidden':'true'});
  const toolbar=h('div.chart-toolbar');
  const status=h('p.chart-note',{role:'status'});
  stage.append(plot,tip,overlay);
  const panel=h('div.price-history',toolbar,stage,status,h('p.chart-credit',h('a',{href:'https://www.tradingview.com/',target:'_blank',rel:'noopener noreferrer'},'Charts by TradingView'),' · Lightweight Charts™ · Copyright © 2026 TradingView, Inc.'));

  let chart,observer,resizeObserver,main,vol,markerApi,rate,scale,unit,revision=0,timer,lastSignature='';
  // A sub-cent token plots at 5e-7, and the library's tick generator throws "unexpected base" on a span that small.
  // Prices are drawn in a scaled domain (x 10^magnitude) and divided back in the formatter.
  let magnitude=0,lastCrosshair=null;
  const axisText=value=>axisLabel(Number(value)/10**magnitude);
  let current={points:[],data:[],vol:[]};
  const decimals=ctx.wallet===ctx.solWallet?6:18;
  const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

  function cleanup(){
    if(chart){try{pref.range=chart.timeScale().getVisibleRange();}catch{/* empty chart */}}
    observer?.disconnect();resizeObserver?.disconnect();chart?.remove();chart=main=vol=markerApi=null;
  }

  // Desktop: the chart sits beside the trade panel, so size it to end just above the fold (300–560 px).
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

  /* ---------- controls ---------- */
  function segment(label,items,value,onPick){
    const pick=event=>{
      const button=event.currentTarget;
      if(button.getAttribute('aria-pressed')==='true')return;
      onPick(button.dataset.value);
      for(const sibling of button.parentElement.children)sibling.setAttribute('aria-pressed',String(sibling===button));
    };
    return h('div.chart-seg',{role:'group','aria-label':label},items.map(([v,text])=>
      h('button.chart-seg-btn',{type:'button','data-value':v,'aria-pressed':String(v===value),on:{click:pick}},text)));
  }
  function markerMenu(){
    const row=(field,label,title)=>h('label.chart-menu-row',{title},h('input',{type:'checkbox',checked:pref[field]!==false,on:{change:event=>{pref[field]=event.target.checked;applyMarkers();}}}),h('span',label));
    return h('details.chart-menu',
      h('summary.chart-menu-summary',{title:'Markers'},icon('chart-candlestick','icon-sm'),h('span.chart-menu-label','Markers')),
      h('div.chart-menu-body',row('dev','Creator trades','Mark the creator’s own buys and sells'),row('mine','My trades','Mark your own buys and sells')));
  }
  function draw(){
    const style=pref.style??'candles';
    // Every control is a direct child, so a narrow screen wraps between controls instead of inside a group.
    toolbar.replaceChildren(
      segment('Chart value',[['price','Price'],['cap','MCap']],pref.basis,v=>{pref.basis=v;draw();load();}),
      markerMenu(),
      segment('Chart style',[['line','Line'],['candles','Candles']],style,v=>{pref.style=v;draw();build();load();}),
      segment('Chart range',RANGES,pref.interval,v=>{pref.interval=Number(v);draw();load();}));
  }

  /* ---------- chart ---------- */
  function build(){
    cleanup();plot.replaceChildren();
    const lib=window.LightweightCharts;
    if(!lib)return false;
    const style=pref.style??'candles';
    const up=tone('--positive','#76ED9A'),down=tone('--negative','#FF9292'),accent=tone('--primary','#ADFF45');
    // --line-soft is already an rgba token: passing it through alpha() would make the grid far too loud.
    const grid=tone('--line-soft','rgba(255,255,255,.086)'),cross=tone('--line-strong','rgba(255,255,255,.22)');
    chart=lib.createChart(plot,{
      width:Math.max(280,plot.clientWidth||plot.parentElement?.clientWidth||320),
      height:Math.max(180,plot.clientHeight||plot.parentElement?.clientHeight||320),
      layout:{background:{type:'solid',color:tone('--paper','#080B09')},textColor:tone('--ink-3','#9AAA9E'),fontFamily:getComputedStyle(document.body).fontFamily,fontSize:11,attributionLogo:false},
      grid:{vertLines:{color:grid,style:lib.LineStyle.Dotted},horzLines:{color:grid,style:lib.LineStyle.Dotted}},
      rightPriceScale:{borderVisible:false,entireTextOnly:true,minimumWidth:64,scaleMargins:{top:.1,bottom:.24}},
      timeScale:{borderVisible:false,timeVisible:pref.interval<86400,secondsVisible:false,rightOffset:3,barSpacing:8,minBarSpacing:1.5,maxBarSpacing:40,fixLeftEdge:false},
      crosshair:{mode:lib.CrosshairMode.Normal,vertLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--surface-3','#222C25')},horzLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--surface-3','#222C25')}},
      localization:{priceFormatter:axisText},
      handleScale:{axisPressedMouseMove:{time:true,price:false}},
    });
    const priceFormat={type:'custom',formatter:axisText,minMove:0.0001};
    if(style==='candles'){
      main=chart.addSeries(lib.CandlestickSeries,{upColor:up,downColor:down,wickUpColor:up,wickDownColor:down,borderVisible:false,priceLineVisible:true,lastValueVisible:true,priceLineStyle:lib.LineStyle.Dashed,priceLineColor:alpha(up,.75),priceFormat},0);
    }else{
      main=chart.addSeries(lib.AreaSeries,{lineColor:accent,lineWidth:2,topColor:alpha(accent,.28),bottomColor:alpha(accent,0),priceLineVisible:true,lastValueVisible:true,priceLineStyle:lib.LineStyle.Dashed,priceLineColor:alpha(accent,.75),crosshairMarkerRadius:3,crosshairMarkerBorderColor:tone('--paper','#080B09'),priceFormat},0);
    }
    // Volume keeps its own scale, pinned to the bottom fifth of the pane and without an axis of its own, so it
    // never squashes the price candles and never adds a second set of numbers.
    vol=chart.addSeries(lib.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},0);
    try{vol.priceScale().applyOptions({scaleMargins:{top:.8,bottom:0},visible:false});}catch{}
    chart.subscribeCrosshairMove(move=>{
      lastCrosshair=move?{time:move.time??null,point:move.point?{x:Math.round(move.point.x),y:Math.round(move.point.y)}:null}:null;
      if(!move?.point||move.time===undefined){hideTip();return;}
      const point=current.points.find(p=>p.timestamp===move.time);
      if(!point){hideTip();return;}
      showTip(move.point,point);
    });
    resizeObserver=new ResizeObserver(()=>{
      if(!chart)return;
      const width=plot.clientWidth,height=plot.clientHeight;
      if(width>0&&height>0)chart.applyOptions({width,height});
    });
    resizeObserver.observe(plot);
    lifecycle.observe(document.body,{childList:true,subtree:true});
    return true;
  }

  function showTip(point,bar){
    const up=bar.close>=bar.open,change=pctText(bar.open,bar.close),volume=quoteVolume(bar);
    const cell=(k,v)=>h('span.chart-tip-cell',h('em',k),v);
    tip.replaceChildren(
      h('div.chart-tip-head',new Date(bar.timestamp*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),change?h('span.chart-tip-chg',{'data-dir':up?'up':'down'},change):null),
      h('div.chart-tip-grid',cell('O',priceText(bar.open)),cell('H',priceText(bar.high)),cell('L',priceText(bar.low)),cell('C',priceText(bar.close))),
      volume===null?null:h('div.chart-tip-foot',h('em','Vol'),volumeUnit==='$'?'$'+compact(volume):`${compact(volume)} ${volumeUnit}`.trim()));
    tip.hidden=false;
    const box=stage.getBoundingClientRect();
    const at=tipPosition(point,{width:tip.offsetWidth||170,height:tip.offsetHeight||84},{width:box.width,height:box.height});
    tip.style.setProperty('transform',`translate(${at.x}px, ${at.y}px)`);
  }
  function hideTip(){if(!tip.hidden)tip.hidden=true;}

  /* ---------- data ---------- */
  const quoteVolume=p=>{
    if(p.quoteVolumeRaw==null&&p.tokenVolumeRaw!=null)return Number(p.tokenVolumeRaw??0)/10**Number(token.decimals??decimals);
    if(p.quoteVolumeRaw==null)return null;
    const value=Number(p.quoteVolumeRaw)/10**Number(token.quoteDecimals??6);
    return rate===null?value:value*(rate??1);
  };
  let volumeUnit='';
  function shape(rows){
    const points=rows.filter(p=>Number.isSafeInteger(p.timestamp)&&Number(p.close)>0&&[p.open,p.high,p.low,p.close].every(v=>Number.isFinite(Number(v)))).sort((a,b)=>a.timestamp-b.timestamp);
    rate=usdRate(token);scale=(pref.basis==='cap'?Number(token.supply??1e9):1)*(rate??1);unit=rate===null?q:'USD';
    const closes=points.map(p=>Number(p.close)*scale).filter(v=>v>0);
    const smallest=closes.length?Math.min(...closes):0;
    magnitude=smallest>0?Math.max(0,Math.min(12,Math.ceil(-Math.log10(smallest))+2)):0;
    const drawScale=scale*10**magnitude;
    const data=points.map(p=>({time:p.timestamp,open:Number(p.open)*drawScale,high:Number(p.high)*drawScale,low:Number(p.low)*drawScale,close:Number(p.close)*drawScale}));
    return {points,data};
  }
  function empty(message,sub){
    overlay.replaceChildren(h('div.chart-empty',icon('chart-candlestick','icon-lg'),h('strong',message),sub?h('span',sub):null));
    overlay.hidden=false;
  }
  function applyMarkers(){
    if(!main)return;
    const source=panel.markerSource,rows=source?.rows?.();
    const bars=new Map(current.data.map(d=>[d.time,d])),lib=window.LightweightCharts;
    const list=rows?tradeMarkers(rows,{creator:source.creator,me:source.me,interval:pref.interval,showDev:pref.dev!==false,showMine:pref.mine!==false}).filter(m=>bars.has(m.time)):[];
    const dev=tone('--primary','#ADFF45'),up=tone('--positive','#76ED9A'),down=tone('--negative','#FF9292');
    // Small circles pinned to the bar's own extreme: an arrow the height of the pane was drowning the candles.
    const markers=list.map(m=>({time:m.time,position:'atPriceMiddle',price:m.side==='buy'?bars.get(m.time).low:bars.get(m.time).high,shape:'circle',size:0.6,color:alpha(m.owner==='dev'?dev:m.side==='buy'?up:down,.85)}));
    try{
      if(!markerApi&&lib?.createSeriesMarkers)markerApi=lib.createSeriesMarkers(main,markers);
      else markerApi?.setMarkers(markers);
    }catch{/* markers are decoration; the chart stays usable without them */}
  }
  panel.refreshMarkers=applyMarkers;
  /** The rendered chart as a canvas, for capture and tests. */
  panel.screenshot=()=>chart?.takeScreenshot?.()??null;
  /** Geometry and data counts, for tests and for diagnosing a rendering problem. */
  panel.debug=()=>({panes:chart?.panes?.().map(p=>p.getHeight?.())??[],style:pref.style??'candles',magnitude,points:current.points.length,volume:current.vol.filter(v=>v!==null).length,interval:pref.interval,basis:pref.basis,crosshair:lastCrosshair,tip:!tip.hidden});

  function paint(points,data){
    const style=pref.style??'candles';
    const hasQuote=points.some(p=>p.quoteVolumeRaw!=null),hasToken=points.some(p=>p.tokenVolumeRaw!=null);
    volumeUnit=hasQuote?(rate===null?(token.quoteSymbol??''):'$'):hasToken?(token.symbol??''):null;
    const up=tone('--positive','#76ED9A'),down=tone('--negative','#FF9292');
    if(!chart)build();
    current={points,data,vol:points.map(quoteVolume)};
    main.setData(style==='candles'?data:data.map(p=>({time:p.time,value:p.close})));
    vol.setData(current.points.map((p,i)=>({time:p.timestamp,value:Number(current.vol[i]??0),color:alpha(data[i].close>=data[i].open?up:down,.45)})));
    applyMarkers();
  }

  async function load(quiet=false){
    const request=++revision;
    if(!quiet){status.textContent='Loading executed trades…';plot.classList.add('is-loading');}
    try{
      const net=ctx.mode==='local'?'':`&network=${encodeURIComponent(ctx.currentChain())}`;
      const base=ctx.mode==='local'?'tokens':'public/tokens';
      const rows=await ctx.api(`${base}/${token.address}/candles?interval=${pref.interval}${net}`);
      if(request!==revision||!panel.isConnected)return;
      const signature=JSON.stringify(rows.slice(-3))+rows.length+pref.basis+(pref.style??'');
      if(quiet&&signature===lastSignature&&chart)return;
      lastSignature=signature;
      plot.classList.remove('is-loading');
      const {points,data}=shape(rows);
      const flat=points.filter(p=>Number(p.open)===Number(p.high)&&Number(p.high)===Number(p.low)&&Number(p.low)===Number(p.close)).length;
      const sparse=flat/Math.max(1,points.length)>=.6;
      if(sparse&&pref.style===null)pref.style='line';
      if(sparse!==panel.sparse){panel.sparse=sparse;draw();build();}
      if(!points.length){
        cleanup();plot.replaceChildren();empty('No trades yet','The chart starts with the first buy or sell.');
        status.textContent='Executed trades only. Nothing is shown until someone trades.';
        return;
      }
      if(!window.LightweightCharts)throw new Error('Chart library could not load.');
      overlay.hidden=true;
      if(!quiet||!chart){build();}
      paint(points,data);
      if(!quiet){
        if(pref.range)chart.timeScale().setVisibleRange(pref.range);
        // Fit only when the history actually fills the pane. A young token has three bars, and stretching them
        // across the whole width reads as a broken chart; keep a normal bar width and let the space stay empty.
        else chart.timeScale().fitContent();
      }
      const lineMode=(pref.style??'candles')==='line';
      status.textContent=`Executed trades only · ${unit}${lineMode&&panel.sparse?' · line mode: most bars hold a single trade':''}. ${rate===null?'USD reference unavailable.':'USD uses the current reference rate, not historical rates.'} Scroll to zoom, drag to pan.`;
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

  draw();overlay.hidden=true;load();
  timer=setInterval(()=>{if(panel.isConnected&&!document.hidden)load(true);},15000);
  if(reduced)tip.classList.add('chart-tip-static');
  return panel;
}
