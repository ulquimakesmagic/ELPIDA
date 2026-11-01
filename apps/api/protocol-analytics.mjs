// Public, read-only analytics. Never includes simulation activity or wallet credentials.
import { usdReferenceFor } from '../../packages/core/pairs.mjs';
export function protocolAnalytics({sources, prices, period='7d', network='all', now=Math.floor(Date.now()/1000)}) {
  const windows={'24h':86400,'7d':604800,'30d':2592000,all:Infinity};
  if (!(period in windows)) throw new Error('Choose 24h, 7d, 30d or all.');
  if(network!=='all'&&!sources.some(s=>s.key===network))throw new Error('Unknown analytics network.');
  const selected=sources.filter(s=>network==='all'||s.key===network), start=now-windows[period];
  const totals={volumeUsd:0,trades:0,launches:0,addresses:0,unpricedTrades:0,tokens:0,graduated:0};
  const accounts=new Set(), assets=new Map(), rankings=[], activity=[], graduations=[];
  const coverage=selected.map(s=>({key:s.key,name:s.name,...s.status}));
  for(const source of selected){
    const tokens=new Map(source.tokens.map(t=>[t.address,t]));
    const ranks=new Map();
    for(const t of tokens.values()){
      totals.tokens++;if(t.graduated)totals.graduated++;
      if(t.graduated&&Number(t.completedAt)>0&&Number(t.completedAt)<=now)graduations.push({address:t.address,name:t.metadata?.name??t.name,symbol:t.metadata?.symbol??t.symbol,network:source.key,chain:source.name,quoteSymbol:t.quoteSymbol??'Quote asset',graduatedAt:Number(t.completedAt),dex:t.dex??null});
      if(t.created/1000>=start&&t.created/1000<=now){totals.launches++;activity.push({timestamp:t.created/1000,launches:1});}
      const ref=usdReferenceFor({...t,network:source.key},prices[source.key],now);
      const rate=ref?.status==='fresh'&&Number.isFinite(ref.usd)&&ref.usd>0&&now-ref.updatedAt<=(ref.maxAge??180)&&ref.updatedAt<=now+60?ref.usd:null;
      const key=source.key+':'+(t.quoteAddress??t.quoteMint??t.quoteSymbol??'native');
      const a=assets.get(key)??{key,network:source.key,chain:source.name,symbol:t.quoteSymbol??'Quote asset',volume:0,volumeUsd:0,trades:0,reserve:0,creatorFees:0,protocolFees:0,priced:rate!==null};
      for(const [field,target] of [['reserve','reserve'],['creatorFees','creatorFees'],['protocolFees','protocolFees']])a[target]+=Math.max(0,Number(t[field])||0);
      assets.set(key,a);ranks.set(t.address,{address:t.address,name:t.metadata?.name??t.name,symbol:t.metadata?.symbol??t.symbol,network:source.key,chain:source.name,quoteSymbol:a.symbol,volume:0,volumeUsd:0,trades:0,priced:rate!==null,rate,asset:key});
    }
    // Read the complete confirmed trade table, rather than the capped token-page history.
    for(const trade of source.trades){
      if(trade.timestamp<start||trade.timestamp>now)continue;
      const rank=ranks.get(String(trade.token)), amount=Number(trade.quoteAmount);
      if(!rank||!Number.isFinite(amount)||amount<=0||Number(trade.tokenAmount)<=0)continue;
      const a=assets.get(rank.asset), usd=rank.rate===null?0:amount*rank.rate;
      totals.trades++;totals.volumeUsd+=usd;if(rank.rate===null)totals.unpricedTrades++;
      if(trade.account)accounts.add(source.key+':'+trade.account);
      rank.volume+=amount;rank.volumeUsd+=usd;rank.trades++;a.volume+=amount;a.volumeUsd+=usd;a.trades++;
      activity.push({timestamp:trade.timestamp,volumeUsd:usd,trades:1});
    }
    rankings.push(...ranks.values());
  }
  totals.addresses=accounts.size;
  const earliest=activity.length?activity.reduce((min,a)=>Math.min(min,a.timestamp),now):now;
  const from=Number.isFinite(start)?start:earliest, step=period==='24h'?3600:period==='all'?Math.max(86400,Math.ceil((now-from)/86400/60)*86400):86400;
  const buckets=new Map();for(let t=Math.floor(from/step)*step;t<=now;t+=step)buckets.set(t,{timestamp:t,volumeUsd:0,trades:0,launches:0});
  for(const a of activity){const b=buckets.get(Math.floor(a.timestamp/step)*step);if(b){b.volumeUsd+=a.volumeUsd??0;b.trades+=a.trades??0;b.launches+=a.launches??0;}}
  return {period,network,updatedAt:now,totals,series:[...buckets.values()],assets:[...assets.values()],graduations:graduations.sort((x,y)=>y.graduatedAt-x.graduatedAt).slice(0,8),topTokens:rankings.sort((a,b)=>b.volumeUsd-a.volumeUsd||b.trades-a.trades).slice(0,10).map(({rate,asset,...r})=>r),coverage,basis:'Confirmed indexed activity only. USD volume uses current fresh price references, not historical exchange rates. Unpriced assets are excluded from USD totals. Trading addresses can include routers. Fee balances are current unclaimed amounts, not protocol revenue.'};
}
