import {h,icon,compact,usdRate} from './ui.mjs';
import {axisLabel,priceText,pctText,tipPosition,tipFields} from './chart-format.mjs';

// Executed-trade chart for the token page: one line over a gradient, the way the reference charts read.
// No candles, no volume, no markers — a token's price is a single series, and a thin history should look thin
// rather than pretending to be a market.
const preferences=new Map();
// Bucket size doubles as the window; ALL keeps hourly buckets and shows everything the index has.
const RANGES=[[3600,'1H'],[14400,'6H'],[86400,'1D'],[3600,'ALL']];
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
  const pref=preferences.get(key)??{basis:'price',range:'1H',interval:3600};
  if(preferences.size>100)preferences.delete(preferences.keys().next().value);
  preferences.set(key,pref);

  const stage=h('div.chart-stage');
  const plot=h('div.terminal-chart',{'aria-label':'Executed-trade price chart',role:'img'});
  const tip=h('div.chart-tip',{'aria-hidden':'true',hidden:true});
  const overlay=h('div.chart-overlay',{'aria-hidden':'true'});
  const toolbar=h('div.chart-toolbar');
  const status=h('p.chart-note',{role:'status'});
  stage.append(plot,tip,overlay);
  const panel=h('div.price-history',toolbar,stage,status,h('p.chart-credit',h('a',{href:'https://www.tradingview.com/',target:'_blank',rel:'noopener noreferrer'},'Charts by TradingView'),' · Lightweight Charts™ · Copyright © 2026 TradingView, Inc.'));

  let chart,resizeObserver,line,rate,scale,unit,revision=0,timer,lastSignature='';
  let current={points:[],data:[]};
  let lastCrosshair=null;
  const decimals=ctx.wallet===ctx.solWallet?6:18;
  // A sub-cent token plots at 5e-7 and the library's tick generator throws "unexpected base" on a span that small, so
  // prices are drawn in a scaled domain and divided back in the formatter.
  let magnitude=0;
  const axisText=value=>axisLabel(Number(value)/10**magnitude);

  function cleanup(){
    if(chart){try{pref.visible=chart.timeScale().getVisibleRange();}catch{/* empty chart */}}
    resizeObserver?.disconnect();chart?.remove();chart=line=null;
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

  /* ---------- controls: value basis and range, nothing else ---------- */
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
  function draw(){
    toolbar.replaceChildren(
      segment('Chart value',[['price','Price'],['cap','MCap']],pref.basis,v=>{pref.basis=v;draw();load();}),
      segment('Chart range',RANGES.map(([interval,label])=>[label,label]),pref.range,v=>{
        pref.range=v;
        pref.interval=RANGES.find(([,label])=>label===v)?.[0]??3600;
        draw();load();
      }));
  }

  /* ---------- chart ---------- */
  function build(){
    cleanup();plot.replaceChildren();
    const lib=window.LightweightCharts;
    if(!lib)return false;
    const accent=tone('--primary','#ADFF45');
    const grid=tone('--line-soft','rgba(255,255,255,.086)'),cross=tone('--line-strong','rgba(255,255,255,.22)');
    chart=lib.createChart(plot,{
      width:Math.max(280,plot.clientWidth||plot.parentElement?.clientWidth||320),
      height:Math.max(180,plot.clientHeight||plot.parentElement?.clientHeight||320),
      layout:{background:{type:'solid',color:tone('--paper','#080B09')},textColor:tone('--ink-3','#9AAA9E'),fontFamily:getComputedStyle(document.body).fontFamily,fontSize:11,attributionLogo:false},
      // Horizontal rules only: a line chart needs a price ladder, not a grid over empty space.
      grid:{vertLines:{visible:false},horzLines:{color:grid,style:lib.LineStyle.Dotted}},
      rightPriceScale:{borderVisible:false,entireTextOnly:true,minimumWidth:64,scaleMargins:{top:.14,bottom:.1}},
      timeScale:{borderVisible:false,timeVisible:true,secondsVisible:false,rightOffset:1,barSpacing:6,minBarSpacing:1.6,maxBarSpacing:120},
      crosshair:{mode:lib.CrosshairMode.Normal,vertLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--surface-3','#222C25')},horzLine:{color:cross,style:lib.LineStyle.Dashed,labelBackgroundColor:tone('--surface-3','#222C25')}},
      localization:{priceFormatter:axisText},
      handleScale:{axisPressedMouseMove:{time:true,price:false}},
    });
    line=chart.addSeries(lib.AreaSeries,{
      lineColor:accent,lineWidth:2,
      topColor:alpha(accent,.26),bottomColor:alpha(accent,0),
      priceLineVisible:true,lastValueVisible:true,priceLineStyle:lib.LineStyle.Dashed,priceLineColor:alpha(accent,.7),
      priceFormat:{type:'custom',formatter:axisText,minMove:0.0001},
      crosshairMarkerRadius:3,crosshairMarkerBorderColor:tone('--paper','#080B09'),
    });
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
    const fields=tipFields(bar,bar.quoteVolumeRaw==null?null:quoteVolume(bar),volumeUnit);
    const cell=(k,v)=>h('span.chart-tip-cell',h('em',k),v);
    tip.replaceChildren(
      h('div.chart-tip-head',new Date(bar.timestamp*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),fields.change?h('span.chart-tip-chg',{'data-dir':fields.up?'up':'down'},fields.change):null),
      h('div.chart-tip-grid',cell('O',priceText(bar.open)),cell('H',priceText(bar.high)),cell('L',priceText(bar.low)),cell('C',priceText(bar.close))));
    tip.hidden=false;
    const box=stage.getBoundingClientRect();
    const at=tipPosition(point,{width:tip.offsetWidth||170,height:tip.offsetHeight||84},{width:box.width,height:box.height});
    tip.style.setProperty('transform',`translate(${at.x}px, ${at.y}px)`);
  }
  function hideTip(){if(!tip.hidden)tip.hidden=true;}

  /* ---------- data ---------- */
  const quoteVolume=p=>{
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
    const draw=scale*10**magnitude;
    const data=points.map(p=>({time:p.timestamp,value:Number(p.close)*draw}));
    return {points,data};
  }
  function empty(message,sub){
    overlay.replaceChildren(h('div.chart-empty',icon('chart-line','icon-lg'),h('strong',message),sub?h('span',sub):null));
    overlay.hidden=false;
  }

  async function load(quiet=false){
    const request=++revision;
    if(!quiet){status.textContent='Loading executed trades…';plot.classList.add('is-loading');}
    try{
      const net=ctx.mode==='local'?'':`&network=${encodeURIComponent(ctx.currentChain())}`;
      const base=ctx.mode==='local'?'tokens':'public/tokens';
      let rows=await ctx.api(`${base}/${token.address}/candles?interval=${pref.interval}${net}`);
      // A bucket wider than the whole history draws a single dot. If the range yields almost nothing, ask for the
      // finest bucket and keep whichever view has more to show.
      if(rows.length<=3&&pref.interval>60){
        const finer=await ctx.api(`${base}/${token.address}/candles?interval=60${net}`);
        if(finer.length>rows.length)rows=finer;
      }
      if(request!==revision||!panel.isConnected)return;
      const signature=JSON.stringify(rows.slice(-3))+rows.length+pref.basis+pref.range;
      if(quiet&&signature===lastSignature&&chart)return;
      lastSignature=signature;
      plot.classList.remove('is-loading');
      const {points,data}=shape(rows);
      if(!points.length){
        cleanup();plot.replaceChildren();empty('No trades yet','The chart starts with the first buy or sell.');
        status.textContent='Executed trades only. Nothing is shown until someone trades.';
        return;
      }
      if(!window.LightweightCharts)throw new Error('Chart library could not load.');
      overlay.hidden=true;
      if(!chart)build();
      current={points,data};
      line.setData(data);
      if(!quiet){
        if(pref.visible&&pref.range!=='ALL')chart.timeScale().setVisibleRange(pref.visible);
        else if(pref.range==='ALL')chart.timeScale().fitContent();
        else chart.timeScale().fitContent();
      }
      status.textContent=`${points.length} ${points.length===1?'bucket':'buckets'} of executed trades · ${unit}. ${rate===null?'USD reference unavailable.':'USD uses the current reference rate, not historical rates.'}`;
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

  /* ---------- hooks used by tests and capture ---------- */
  panel.screenshot=()=>chart?.takeScreenshot?.()??null;
  panel.debug=()=>({basis:pref.basis,range:pref.range,interval:pref.interval,magnitude,points:current.points.length,series:chart?1:0,crosshair:lastCrosshair,tip:!tip.hidden});

  draw();overlay.hidden=true;load();
  // Only the chart that is actually on screen may keep polling. A view that was replaced without being
  // disconnected kept fetching the previous token every 15 s, which is what the request log showed.
  timer=setInterval(()=>{
    if(!panel.isConnected||document.querySelector('.price-history')!==panel){clearInterval(timer);cleanup();return;}
    if(!document.hidden)load(true);
  },15000);
  return panel;
}
