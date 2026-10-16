import { nowSeconds } from './clock.mjs';
export function freshUsd(token,now=nowSeconds()){const p=token.usdReference;return p?.status==='fresh'&&Number.isFinite(p.usd)&&p.usd>0&&now-p.updatedAt<=(p.maxAge??180)?p.usd:null;}
export function discoveryTokens(tokens,{query='',category='all'}={},now=nowSeconds()){
  const items=tokens.filter(t=>`${t.name} ${t.symbol}`.toLowerCase().includes(query.trim().toLowerCase())).filter(t=>category==='migrating'?t.complete&&!t.graduated:category==='graduated'?t.graduated:true);
  const identity=t=>`${t.network??'local'}:${t.address}`;
  return items.sort((a,b)=>{
    if(category==='new')return (b.created??0)-(a.created??0)||identity(a).localeCompare(identity(b));
    const rateA=freshUsd(a,now),rateB=freshUsd(b,now);
    if(rateA===null||rateB===null){if(rateA!==rateB)return rateA===null?1:-1;}
    const cap=t=>Number(t.spotPrice??0)*Number(t.supply??0);
    return cap(b)*(rateB??0)-cap(a)*(rateA??0)||identity(a).localeCompare(identity(b));
  });
}
export function indexedChange(db,token,now=Math.floor(Date.now()/1000)){
  // Compare executions in the quote asset, not current USD FX or an invented launch price.
  const column=db.prepare('PRAGMA table_info(trades)').all().some(c=>c.name==='mint')?'mint':'address';
  const row=db.prepare(`SELECT data FROM trades WHERE ${column}=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1`).get(token.address,now-86400);
  const latest=db.prepare(`SELECT data FROM trades WHERE ${column}=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1`).get(token.address,now);
  if(!row||!latest)return null;
  const old=JSON.parse(row.data),next=JSON.parse(latest.data);
  if(old.timestamp<now-90000||next.timestamp<now-3600||!(old.priceQuote>0)||!(next.priceQuote>0))return null;
  return {percent:(next.priceQuote/old.priceQuote-1)*100,interval:'24h',basis:'Confirmed execution prices in the trading pair; includes trader fees',from:old.timestamp,to:next.timestamp};
}
