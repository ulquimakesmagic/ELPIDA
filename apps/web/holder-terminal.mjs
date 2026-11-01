import {h,number,compact,fmtValue,fmtMarketCap,usdRate} from './ui.mjs';
export function holderTerminal(ctx,token,{onVolume}={}){
 const network=ctx.currentChain(),author=ctx.mode==='testnet'?ctx.wallet.address:ctx.state.wallet;
 const positionBody=h('div',h('p.small.muted','Loading your position…')),position=h('section.panel.position-panel',{'aria-labelledby':'position-title'},h('h2#position-title','Your position'),positionBody);
 async function load(){try{const data=await ctx.api(`terminal?network=${encodeURIComponent(network)}&token=${token.address}${author?`&author=${encodeURIComponent(author)}`:''}`);if(!position.isConnected)return;onVolume?.(data.volume24hQuote);
   if(!author||ctx.state.disconnected){positionBody.replaceChildren(h('p.muted','Connect a wallet to see your holdings, entry market cap and P&L.'));}
   else {const p=data.position,field=(label,value)=>h('div.position-stat',h('span.meta',label),h('strong',value));
    const sign=Number(p?.unrealizedQuote)>=0?'+':'',pnlValue=value=>{const rate=usdRate(token),v=Math.abs(Number(value));return rate!==null&&v*rate>0&&v*rate<0.01?'$'+number(v*rate,6):fmtValue(v,token);};
    positionBody.replaceChildren(h('div.position-grid',field('Tokens held',compact(p?.balance??0)+' '+token.symbol),field('Share of total supply',number(Number(p?.supplyShare??0)*100,4)+'%'),field('Position value',fmtValue(p?.valueQuote??0,token)),field('Average entry MC',p?.entryMarketCapQuote===null?'Unknown':fmtMarketCap(token,p.entryMarketCapQuote))),h('div.position-pnl',{'data-dir':p?.basisKnown?(Number(p.unrealizedQuote)>=0?'up':'down'):'unknown'},h('span','Unrealized P&L'),h('strong',p?.basisKnown?`${Number(p.unrealizedQuote)<0?'-':sign}${pnlValue(p.unrealizedQuote)} (${sign}${number(p.unrealizedPercent,2)}%)`:'Unknown cost basis')),h('p.small.muted',p?.reason??'Position data unavailable.'),...(p?.basisKnown?[h('p.hint',`Realized P&L: ${fmtValue(p.realizedQuote,token)}. ${usdRate(token)===null?'Values use the trading-pair asset.':'USD values use the current conversion rate.'}`)]:[]));
   }
  }catch(e){positionBody.replaceChildren(h('p.small.muted','Position data is temporarily unavailable.'),h('button.btn.btn-secondary.btn-sm',{type:'button',on:{click:load}},'Retry'));}}
 load();return {position};
}
