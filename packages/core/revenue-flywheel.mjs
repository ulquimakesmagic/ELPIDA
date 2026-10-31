// Planning only. Callers supply verified receipts and market data; this module never transfers funds.
export function planRevenueFlywheel({chain,asset,receipts,tokens,usedReceiptIds=[],now,maxAgeSec=300}) {
  if(!chain||!asset||!Number.isSafeInteger(now)||!Number.isSafeInteger(maxAgeSec)||maxAgeSec<=0)throw new Error('Invalid flywheel scope.');
  const used=new Set(usedReceiptIds),seen=new Set();let received=0n;
  for(const r of receipts){
    if(!r.id||seen.has(r.id))throw new Error('Duplicate or missing protocol receipt.');seen.add(r.id);
    if(used.has(r.id))continue;
    if(r.chain!==chain||r.asset!==asset||r.kind!=='protocol-fee-received'||typeof r.amount!=='bigint'||r.amount<0n)throw new Error('Not a received protocol fee in this budget scope.');
    received+=r.amount;
  }
  const ids=new Set();
  const ranked=tokens.filter(t=>{
    if(!t.id||ids.has(t.id))throw new Error('Duplicate token identity.');ids.add(t.id);
    return t.chain===chain&&t.budgetAsset===asset&&t.verified===true&&t.burnSupported===true&&t.routeReady===true&&t.issuerAllowed===true&&t.marketCap>0n&&typeof t.marketCap==='bigint'&&Number.isSafeInteger(t.observedAt)&&t.observedAt<=now&&now-t.observedAt<=maxAgeSec;
  }).sort((a,b)=>a.marketCap>b.marketCap?-1:a.marketCap<b.marketCap?1:a.id.localeCompare(b.id)).slice(0,10);
  const budget=received/10n,perSlot=budget/10n;
  const orders=ranked.map((t,i)=>({rank:i+1,token:t.id,maximumSpend:perSlot})).filter(o=>o.maximumSpend>0n);
  return {chain,asset,received,budget,orders,unallocated:budget-perSlot*BigInt(orders.length),receiptIds:[...seen].filter(id=>!used.has(id)),executionEnabled:false};
}
