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

/**
 * Flywheel cycle policy (decided 1 November 2026): the treasury tops up a dedicated keeper wallet with 10% of the
 * protocol fees it received; each cycle splits what the wallet may spend into ten equal slots for the ten eligible
 * Elpida tokens with the highest market cap on that chain, buys each one and sends what it buys to the dead address.
 * A slot is also capped by depth, so a small or thin market never takes a large order; whatever is not spent stays
 * in the wallet for the next cycle.
 */
export const FLYWHEEL_POLICY = Object.freeze({
  slots: 10,
  minAgeSec: 86_400,          // a token must be a day old: no buying into a launch or its anti-snipe window
  curveShareBps: 2_500,       // on the curve, at most 25% of what is left to complete it (the flywheel never graduates a curve)
  poolDepthBps: 50,           // on a pool, at most 0.5% of its quote balance
});

/**
 * Plans one cycle for one chain. `tokens` are index records already converted to integers in the chain's native
 * unit: { address, symbol, pair, graduated, complete, pool, curve, created (ms), marketCap, remainingBuy, poolReserve,
 * restricted }. Only native-pair tokens qualify: the budget is the native coin and no conversion is attempted.
 */
export function planFlywheelCycle({ chain, budget, tokens, now, policy = FLYWHEEL_POLICY }) {
  if (!chain || typeof budget !== 'bigint' || budget < 0n || !Number.isSafeInteger(now)) throw new Error('Invalid flywheel cycle.');
  const seen = new Set();
  const eligible = tokens.filter(t => {
    const id = String(t.address ?? '').toLowerCase();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    if (t.pair !== 'native' || t.restricted || typeof t.marketCap !== 'bigint' || t.marketCap <= 0n) return false;
    if (!Number.isFinite(Number(t.created)) || Number(t.created) / 1000 > now - policy.minAgeSec) return false;
    return t.graduated ? !!t.pool && typeof t.poolReserve === 'bigint' && t.poolReserve > 0n : !t.complete && !!t.curve && typeof t.remainingBuy === 'bigint' && t.remainingBuy > 0n;
  }).sort((a, b) => a.marketCap > b.marketCap ? -1 : a.marketCap < b.marketCap ? 1 : String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase()))
    .slice(0, policy.slots);
  const perSlot = budget / BigInt(policy.slots);
  const orders = eligible.map((t, i) => {
    const cap = t.graduated ? t.poolReserve * BigInt(policy.poolDepthBps) / 10_000n : t.remainingBuy * BigInt(policy.curveShareBps) / 10_000n;
    return { rank: i + 1, token: t.address, symbol: t.symbol ?? null, venue: t.graduated ? 'pool' : 'curve', pool: t.pool ?? null, curve: t.curve ?? null, marketCap: t.marketCap, spend: perSlot < cap ? perSlot : cap };
  }).filter(o => o.spend > 0n);
  const planned = orders.reduce((sum, o) => sum + o.spend, 0n);
  return { chain, budget, perSlot, orders, unallocated: budget - planned };
}
