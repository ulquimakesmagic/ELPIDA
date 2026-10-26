import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Contract, Interface, ZeroAddress, formatUnits, parseUnits } from 'ethers';
import { supplyPercent } from '../core/curve-model.mjs';
import {creatorRecipients} from '../../apps/web/tax-allocation.mjs';

const dead = '0x000000000000000000000000000000000000dead';
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const decode = value => value ? JSON.parse(value) : null;
// Exact decimal display arithmetic; never convert balances to JS Number.
export function ratio(numerator, denominator, digits = 24) {
  if (denominator === 0n) return null;
  return formatUnits(numerator * 10n ** BigInt(digits) / denominator, digits);
}

/** Durable Elpida EVM indexer. Protocol adapters currently cover curves and custom test pools only. */
export class EvmIndexer {
  constructor({provider, factory, contracts, path = ':memory:', chainId = 31337, fromBlock = 0, confirmations = 0, nativeSymbol = 'ETH', batchSize = 1, dexName = 'Uniswap v3'}) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path); this.provider = provider; this.factory = factory.toLowerCase();
    this.chainId = chainId; this.fromBlock = fromBlock; this.confirmations = confirmations; this.nativeSymbol = nativeSymbol; this.dexName = dexName;
    this.contracts = contracts; this.interfaces = Object.fromEntries(['factory','curve','pool','token',...(contracts.dexPool?['dexPool']:[])].map(k=>[k,new Interface(contracts[k].abi)]));
    this.batchSize = Math.max(1, Math.min(500, batchSize));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, height INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (tx TEXT NOT NULL, idx INTEGER NOT NULL, height INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tx,idx));
      CREATE TABLE IF NOT EXISTS snapshots (address TEXT NOT NULL, height INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(address,height));
      CREATE TABLE IF NOT EXISTS trades (tx TEXT NOT NULL, idx INTEGER NOT NULL, address TEXT NOT NULL, height INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tx,idx));`);
    const identity = json({chainId,factory:this.factory,fromBlock});
    const prior = this.db.prepare('SELECT value FROM identity WHERE id=1').get();
    if (prior && prior.value !== identity) { this.db.close(); throw new Error('Indexer database belongs to a different deployment.'); }
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(identity);
    this.queue = Promise.resolve(); this.lastError = null;
  }
  tip() {return this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();}
  tokens() {return this.db.prepare('SELECT data FROM tokens ORDER BY height DESC,address').all().map(r=>decode(r.data));}
  snapshot(address) {return decode(this.db.prepare('SELECT data FROM snapshots WHERE address=? ORDER BY height DESC LIMIT 1').get(address.toLowerCase())?.data);}
  listings() {return this.tokens().map(t=>({...t,...this.snapshot(t.address)}));}
  rollback(height) {
    this.db.exec('BEGIN IMMEDIATE');
    try {for(const table of ['blocks','tokens','events','snapshots','trades']) this.db.prepare(`DELETE FROM ${table} WHERE height>?`).run(height);this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  sync() {
    const pending = this.queue.then(()=>this.scan());
    this.queue = pending.catch(e=>{this.lastError=String(e.message);});
    return pending;
  }
  async scan() {
    const head = Number(await this.provider.send('eth_blockNumber',[])), target = head - this.confirmations;
    this.head=head;
    let tip = this.tip();
    while(tip) {
      const current = await this.provider.getBlock(tip.height);
      if (current?.hash === tip.hash && tip.height <= target) break;
      this.rollback(tip.height-1);tip=this.tip();
    }
    for(let height = tip ? tip.height+1 : this.fromBlock; height<=target; height+=this.batchSize) {
      const end=Math.min(target,height+this.batchSize-1);
      if(this.batchSize===1){await this.scanBlock(height);continue;}
      // Watch creation, transfers, curve trades and pool swaps in bounded ranges.
      // Fetch new markets too: a token may launch and trade several times in one range.
      const known=this.tokens(), watched=new Set([this.factory,...known.flatMap(t=>[t.address,t.curve,...(this.snapshot(t.address)?.graduated?[this.snapshot(t.address).pool]:[])])]);
      const logs=await this.provider.getLogs({address:[...watched],fromBlock:height,toBlock:end});
      const fresh=[];
      for(const l of logs){const e=this.parse('factory',l);if(l.address.toLowerCase()===this.factory&&e?.name==='Launched')fresh.push(e.args.token,e.args.curve);}
      if(fresh.length)logs.push(...await this.provider.getLogs({address:[...new Set(fresh)],fromBlock:height,toBlock:end}));
      const pools=[];
      for(const l of logs){const e=this.parse('curve',l);if(e?.name==='Graduated'&&!watched.has(e.args.pool.toLowerCase()))pools.push(e.args.pool);}
      if(pools.length)logs.push(...await this.provider.getLogs({address:[...new Set(pools)],fromBlock:height,toBlock:end}));
      const heights=[...new Set([...logs.map(l=>l.blockNumber),end])].sort((a,b)=>a-b);
      for(const h of heights)await this.scanBlock(h);
    }
    this.head=head;this.lastError=null;
    return this.status();
  }
  async scanBlock(height) {
    const block = await this.provider.getBlock(height);
    if(!block) throw new Error('Block unavailable; retry indexing.');
    const tip=this.tip(); if(tip && (height===tip.height+1?block.parentHash!==tip.hash:(await this.provider.getBlock(tip.height))?.hash!==tip.hash)) throw new Error('Chain changed during indexing; retry.');
    const call={blockTag:height};
    const launches=await this.provider.getLogs({address:this.factory,fromBlock:height,toBlock:height});
    const metadataURIs=new Map(launches.map(log=>this.parse('factory',log)).filter(e=>e?.name==='MetadataPublished').map(e=>[e.args.token.toLowerCase(),e.args.uri]));
    const known=this.tokens(), fresh=[];
    for(const log of launches) {
      const e=this.parse('factory',log);if(e?.name!=='Launched')continue;
      const token=new Contract(e.args.token,this.contracts.token.abi,this.provider);
      const curve=new Contract(e.args.curve,this.contracts.curve.abi,this.provider);
      const native=e.args.nativePair;
      const custom=launches.some(l=>{const parsed=this.parse('factory',l);return parsed?.name==='CustomPair'&&parsed.args.token.toLowerCase()===e.args.token.toLowerCase();});
      const quote = await curve.quote(call);
      const d=native?18:Number(await new Contract(quote,['function decimals() view returns(uint8)'],this.provider).decimals(call));
      const [name,symbol,reward,virtualQuote,virtualToken,saleCap] = await Promise.all([token.name(call),token.symbol(call),curve.creatorRewardVault(call),curve.virtualQuote(call),curve.virtualToken(call),curve.SALE_CAP(call)]);
      // Model 10 curves expose their launch time and anti-snipe schedule; legacy curves do not.
      let schedule=null;
      try{const [launchedAt,base,start,window,grace]=await Promise.all([curve.launchedAt(call),curve.FEE_BPS(call),curve.SNIPE_START_BPS(call),curve.SNIPE_WINDOW(call),curve.graduationGrace(call)]);schedule={launchedAt:Number(launchedAt),feeSchedule:{base:Number(base),start:Number(start),window:Number(window)},graduationGrace:Number(grace)};}catch{/* Legacy model 9 or earlier. */}
      let kind=native?'native':'token';
      if(custom){try{kind=await new Contract(quote,['function pairKind() view returns(string)'],this.provider).pairKind(call)==='xstock'?'xstock':'token';}catch{kind='token';}}
      if(!native){try{if((await new Contract(this.factory,['function feeUsdc() view returns(address)'],this.provider).feeUsdc(call)).toLowerCase()===quote.toLowerCase())kind='usdc';}catch{/* Older deployments lack independent USDC payment. */}}
      fresh.push({address:e.args.token.toLowerCase(),metadataURI:metadataURIs.get(e.args.token.toLowerCase())??'',curve:e.args.curve.toLowerCase(),creator:e.args.creator,reward,name,symbol,pair:kind,quoteAddress:quote,quoteDecimals:d,quoteSymbol:native?this.nativeSymbol:await new Contract(quote,['function symbol() view returns(string)'],this.provider).symbol(call),virtualQuote:virtualQuote.toString(),virtualToken:virtualToken.toString(),saleCapRaw:saleCap.toString(),created:block.timestamp*1000,creationBlock:height,hash:log.transactionHash,curveModel:schedule?10:null,partialFill:!!schedule,...(schedule??{})});
    }
    if(this.contracts.tax)for(const r of fresh)r.creatorRecipients=await creatorRecipients(Contract,this.provider,r.reward,{blockTag:height});
    const records=[...known,...fresh], addressMap=new Map();
    for(const r of records) {
      addressMap.set(r.curve,{r,kind:'curve'});addressMap.set(r.address,{r,kind:'token'});
      const old=this.snapshot(r.address);if(old?.graduated)addressMap.set(old.pool.toLowerCase(),{r,kind:this.contracts.dexPool?'dexPool':'pool'});
    }
    // New curve first buys occur BEFORE Launched; scan the entire creation block.
    let logs=addressMap.size?await this.provider.getLogs({address:[...addressMap.keys()],fromBlock:height,toBlock:height}):[];
    const newPools=[];
    for(const l of logs) {
      const info=addressMap.get(l.address.toLowerCase());
      const e=this.parse(info.kind,l);
      if(e?.name==='Graduated' && !addressMap.has(e.args.pool.toLowerCase())) {addressMap.set(e.args.pool.toLowerCase(),{r:info.r,kind:this.contracts.dexPool?'dexPool':'pool'});newPools.push(e.args.pool);}
    }
    if(newPools.length) logs.push(...await this.provider.getLogs({address:newPools,fromBlock:height,toBlock:height}));
    // Creator transparency: the atomic first buy is the curve's Bought event inside the launch transaction.
    for(const r of fresh){
      const first=logs.filter(l=>l.address.toLowerCase()===r.curve&&l.transactionHash===r.hash).map(l=>this.parse('curve',l)).find(e=>e?.name==='Bought');
      r.devBoughtRaw=(first?.args.tokensOut??0n).toString();r.devBoughtPct=supplyPercent(r.devBoughtRaw);
    }
    const snapshots=[];
    for(const r of records) snapshots.push([r,await this.readSnapshot(r,height,block)]);
    // Refuse to commit an inconsistent history if the block was replaced mid-read.
    if((await this.provider.getBlock(height))?.hash!==block.hash)throw new Error('Chain changed during indexing; retry.');
    logs.push(...launches);logs.sort((a,b)=>a.transactionIndex-b.transactionIndex || a.index-b.index);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO blocks VALUES(?,?,?,?)').run(height,block.hash,block.parentHash,block.timestamp);
      for(const r of fresh)this.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(r.address,height,json(r));
      for(const l of logs) {
        const info=addressMap.get(l.address.toLowerCase()),kind=info?.kind??'factory',e=this.parse(kind,l);
        if(!e)continue;
        this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(l.transactionHash,l.index,height,json({address:l.address,kind,name:e.name,args:e.args.toArray(),blockHash:block.hash}));
        if(info && (['Bought','Sold'].includes(e.name)||e.name==='Swap')) {
          const dex=e.name==='Swap',first=this.snapshot(info.r.address)?.tokenFirst??snapshots.find(([r])=>r.address===info.r.address)?.[1].tokenFirst;
          const tokenDelta=dex?(this.contracts.tax?(first?e.args.amount0In-e.args.amount0Out:e.args.amount1In-e.args.amount1Out):(first?e.args.amount0:e.args.amount1)):0n,quoteDelta=dex?(this.contracts.tax?(first?e.args.amount1In-e.args.amount1Out:e.args.amount0In-e.args.amount0Out):(first?e.args.amount1:e.args.amount0)):0n;
          const buy=dex?quoteDelta>0n:e.name==='Bought',q=dex?(quoteDelta<0n?-quoteDelta:quoteDelta):buy?e.args.quoteIn:e.args.quoteOut,t=dex?(tokenDelta<0n?-tokenDelta:tokenDelta):buy?e.args.tokensOut:e.args.tokensIn,d=info.r.quoteDecimals;
          if(q===0n||t===0n)continue;
          const trade={hash:l.transactionHash,index:l.index,token:info.r.address,market:l.address,venue:kind,side:buy?'buy':'sell',account:dex?(e.args.recipient??e.args.to):buy?e.args.recipient:e.args.seller,sender:dex?e.args.sender:null,accountBasis:dex?'pool recipient; payer may be a router':null,quoteRaw:q.toString(),tokenRaw:t.toString(),quoteAmount:formatUnits(q,d),tokenAmount:formatUnits(t,18),quoteSymbol:info.r.quoteSymbol,priceQuote:ratio(q*10n**18n,t*10n**BigInt(d)),priceBasis:'execution, including trader fees',timestamp:block.timestamp,blockNumber:height};
          this.db.prepare('INSERT OR IGNORE INTO trades VALUES(?,?,?,?,?,?)').run(l.transactionHash,l.index,info.r.address,height,block.timestamp,json(trade));
        }
      }
      for(const [r,s]of snapshots)this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(r.address,height,json(s));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  parse(kind,log){try{return this.interfaces[kind].parseLog(log);}catch{return null;}}
  async readSnapshot(r,height,block) {
    const call={blockTag:height},c=new Contract(r.curve,this.contracts.curve.abi,this.provider),t=new Contract(r.address,this.contracts.token.abi,this.provider);
    const [pool,sold,complete,supply,deadBalance,devHolding] = await Promise.all([c.pool(call),c.sold(call),c.complete(call),t.totalSupply(call),t.balanceOf(dead,call),t.balanceOf(r.creator,call)]);
    // Live creator holding and, for model 10, the locked anti-snipe bonus and graduation escape-hatch timing.
    const dev={devHoldingRaw:devHolding.toString(),devHoldingPct:supplyPercent(devHolding,supply)};
    if(this.contracts.tax){const [buy,sell]=await Promise.all([t.buyTaxBps(call),t.sellTaxBps(call)]);dev.tax={buyBps:Number(buy),sellBps:Number(sell),protocolBps:3000,creatorBps:7000};dev.factory=this.factory;}
    if(r.curveModel===10){const [bonus,completedAt]=await Promise.all([c.liquidityBonus(call),c.completedAt(call)]);Object.assign(dev,{liquidityBonus:formatUnits(bonus,r.quoteDecimals),completedAt:Number(completedAt),reopenableAt:complete&&pool===ZeroAddress&&completedAt>0n?Number(completedAt)+r.graduationGrace:null});}
    const graduated=pool!==ZeroAddress,m=graduated?new Contract(pool,this.contracts.pool.abi,this.provider):c;
    // A curve reopened after its graduation grace is fully sold but no longer complete. Its completion quote then
    // reverts (nothing is left to buy until a holder sells), so it must not be called: that would stop the index.
    const soldOut=!complete&&!graduated&&r.saleCapRaw!=null&&sold>=BigInt(r.saleCapRaw);
    dev.soldOut=soldOut;
    if(graduated && this.contracts.tax)return {...await this.readV2Snapshot(r,height,block,{c,t,pool,sold,complete,supply,deadBalance}),...dev};
    if(graduated && this.contracts.dexPool)return {...await this.readDexSnapshot(r,height,block,{c,t,pool,sold,complete,supply,deadBalance}),...dev};
    const [reserve,cp,cc] = await Promise.all([m.realReserve(call),c.protocolFees(call),c.creatorFees(call)]);
    const poolTokens=graduated?await m.tokenReserve(call):0n;
    const q=graduated?reserve:BigInt(r.virtualQuote)+reserve,base=graduated?poolTokens:BigInt(r.virtualToken)-sold,d=r.quoteDecimals;
    const price=ratio(q*10n**18n,base*10n**BigInt(d));
    // Free circulating estimate excludes curve/pool inventory and the known dead address.
    const inventory=await t.balanceOf(r.curve,call)+(graduated?await t.balanceOf(pool,call):0n),circulating=supply-deadBalance-inventory;
    const marketCap=ratio(q*circulating,base*10n**BigInt(d)),fdv=ratio(q*supply,base*10n**BigInt(d));
    const pf=graduated?await m.protocolFees(call):0n,cf=graduated?await m.creatorFees(call):0n;
    return {pool,graduated,complete,liquidityLocked:graduated,reserve:formatUnits(reserve,d),sold:formatUnits(sold,18),supply:formatUnits(supply,18),circulatingSupply:formatUnits(circulating,18),deadSupply:formatUnits(deadBalance,18),saleCap:formatUnits(BigInt(r.saleCapRaw),18),spotPrice:price,fdvQuote:fdv,circulatingMarketCapQuote:marketCap,supplyPolicy:'exclude curve/pool inventory and known dead address v1',priceUsd:null,usdBasis:null,protocolFees:formatUnits(cp+pf,d),creatorFees:formatUnits(cc+cf,d),remainingBuy:complete||soldOut?'0':formatUnits(await c.completionQuote(call),d),...(r.curveModel===10?{remainingBase:complete||soldOut?'0':formatUnits(await c.remainingAtBaseFee(call),d)}:{}),indexedBlock:height,indexedBlockHash:block.hash,priceTimestamp:block.timestamp,...dev};
  }
  async readDexSnapshot(r,height,block,{c,t,pool,sold,complete,supply,deadBalance}) {
    const call={blockTag:height},m=new Contract(pool,this.contracts.dexPool.abi,this.provider),[slot,asset0,asset1,liquidity,fee,lockerAddress,splitterAddress,positionId,cp,cc]=await Promise.all([m.slot0(call),m.token0(call),m.token1(call),m.liquidity(call),m.fee(call),c.locker(call),c.feeSplitter(call),c.positionId(call),c.protocolFees(call),c.creatorFees(call)]);
    const tokenFirst=asset0.toLowerCase()===r.address,quoteAsset=tokenFirst?asset1:asset0,d=r.quoteDecimals;
    const square=slot[0]*slot[0],Q=2n**192n,n=tokenFirst?square:Q,den=tokenFirst?Q:square;
    const inventory=await t.balanceOf(r.curve,call)+await t.balanceOf(pool,call),circulating=supply-deadBalance-inventory;
    const price=ratio(n*10n**18n,den*10n**BigInt(d)),reserve=await new Contract(quoteAsset,['function balanceOf(address) view returns(uint256)'],this.provider).balanceOf(pool,call);
    const locker=new Contract(lockerAddress,this.contracts.locker.abi,this.provider),manager=new Contract(await locker.manager(call),['function ownerOf(uint256) view returns(address)'],this.provider);
    const locked=await locker.locked(call)&&(await manager.ownerOf(positionId,call)).toLowerCase()===lockerAddress.toLowerCase();
    const splitter=new Contract(splitterAddress,this.contracts.splitter.abi,this.provider),rewards=[];
    for(const asset of [asset0,asset1]){const tokenAsset=asset.toLowerCase()===r.address;rewards.push({asset,symbol:tokenAsset?r.symbol:r.pair==='native'?'WETH':r.quoteSymbol,decimals:tokenAsset?18:d,creator:formatUnits(await splitter.claimable(asset,r.reward,call),tokenAsset?18:d)});}
    return {pool,graduated:true,complete,liquidityLocked:locked,locker:lockerAddress,feeSplitter:splitterAddress,positionId:positionId.toString(),venue:this.dexName,feeBps:Number(fee)/100,tokenFirst,quoteAsset,liquidity:liquidity.toString(),reserve:formatUnits(reserve,d),reserveBasis:'actual DEX quote balance, including uncollected fees',sold:formatUnits(sold,18),supply:formatUnits(supply,18),circulatingSupply:formatUnits(circulating,18),deadSupply:formatUnits(deadBalance,18),saleCap:formatUnits(BigInt(r.saleCapRaw),18),spotPrice:price,fdvQuote:ratio(n*supply,den*10n**BigInt(d)),circulatingMarketCapQuote:ratio(n*circulating,den*10n**BigInt(d)),supplyPolicy:'exclude curve/pool inventory and known dead address v1',priceUsd:null,usdBasis:null,protocolFees:formatUnits(cp,d),creatorFees:formatUnits(cc,d),dexRewards:rewards,rewardsBasis:'collected fees available to claim; collect the position to settle more',remainingBuy:'0',indexedBlock:height,indexedBlockHash:block.hash,priceTimestamp:block.timestamp};
  }
  async readV2Snapshot(r,height,block,{c,t,pool,sold,complete,supply,deadBalance}){
    const call={blockTag:height},m=new Contract(pool,this.contracts.dexPool.abi,this.provider);
    const [asset0,asset1,reserves,lp,locked,cp,cc,allocation]=await Promise.all([m.token0(call),m.token1(call),m.getReserves(call),m.totalSupply(call),m.balanceOf(dead,call),c.protocolFees(call),c.creatorFees(call),c.creatorRewardVault(call)]);
    const first=asset0.toLowerCase()===r.address,rt=first?reserves[0]:reserves[1],rq=first?reserves[1]:reserves[0],d=r.quoteDecimals;
    const circulating=supply-deadBalance-await t.balanceOf(r.curve,call)-await t.balanceOf(pool,call);
    return {pool,graduated:true,complete,liquidityLocked:locked>0n,locker:dead,feeSplitter:allocation,positionId:'0',venue:'Uniswap v2',feeBps:30,tokenFirst:first,quoteAsset:first?asset1:asset0,liquidity:String(lp),reserve:formatUnits(rq,d),reserveBasis:'V2 reserves',sold:formatUnits(sold,18),supply:formatUnits(supply,18),circulatingSupply:formatUnits(circulating,18),deadSupply:formatUnits(deadBalance,18),saleCap:formatUnits(BigInt(r.saleCapRaw),18),spotPrice:ratio(rq*10n**18n,rt*10n**BigInt(d)),fdvQuote:ratio(rq*supply,rt*10n**BigInt(d)),circulatingMarketCapQuote:ratio(rq*circulating,rt*10n**BigInt(d)),priceUsd:null,usdBasis:null,protocolFees:formatUnits(cp,d),creatorFees:formatUnits(cc,d),dexRewards:[{asset:r.address,symbol:r.symbol,decimals:18,creator:formatUnits(await t.balanceOf(allocation,call),18)}],rewardsBasis:'creator token-tax allocation; V2 LP fees compound in permanently locked liquidity',remainingBuy:'0',indexedBlock:height,indexedBlockHash:block.hash,priceTimestamp:block.timestamp};
  }
  /** Latest trades across every token of this index, newest first (the "Last sale" strip). */
  recentTrades(limit=20){return this.db.prepare('SELECT timestamp,data FROM trades ORDER BY timestamp DESC,height DESC,idx DESC LIMIT ?').all(Math.max(1,Math.min(100,limit))).map(r=>({...decode(r.data),timestamp:r.timestamp}));}
  trades(address,limit=100){return this.db.prepare('SELECT data FROM trades WHERE address=? ORDER BY height DESC,idx DESC LIMIT ?').all(address.toLowerCase(),Math.max(1,Math.min(500,limit))).map(r=>decode(r.data));}
  holders(address,limit=50){
    const balances=new Map(),token=this.tokens().find(t=>t.address===address.toLowerCase());if(!token)return [];
    for(const row of this.db.prepare('SELECT data FROM events ORDER BY height,idx').all()){
      const e=decode(row.data);if(e.address.toLowerCase()!==token.address||e.kind!=='token'||e.name!=='Transfer')continue;
      const [from,to,value]=e.args,n=BigInt(value);for(const [a,delta]of [[from,-n],[to,n]]){const key=a.toLowerCase();balances.set(key,(balances.get(key)??0n)+delta);}
    }
    const excluded=new Set([ZeroAddress,dead,token.curve,this.snapshot(token.address)?.pool].filter(Boolean).map(a=>a.toLowerCase()));
    const supply=parseUnits(this.snapshot(token.address)?.supply??'0',18);
    return [...balances].filter(([a,n])=>n>0n&&!excluded.has(a)).sort((a,b)=>a[1]>b[1]?-1:a[1]<b[1]?1:0).slice(0,limit).map(([address,n])=>({address,balance:formatUnits(n,18),supplyShare:ratio(n,supply,12)}));
  }
  /** One wallet's balance in every listed token, from a single pass over Transfer events (the same source as holders()). */
  balancesOf(owner){
    const who=String(owner??'').toLowerCase();if(!/^0x[0-9a-f]{40}$/.test(who))throw new Error('Invalid owner address.');
    const listed=new Set(this.tokens().map(t=>t.address)),balances=new Map();
    for(const row of this.db.prepare('SELECT data FROM events ORDER BY height,idx').all()){
      const e=decode(row.data);if(e.kind!=='token'||e.name!=='Transfer')continue;
      const token=e.address.toLowerCase();if(!listed.has(token))continue;
      const [from,to,value]=e.args,n=BigInt(value);
      if(String(from).toLowerCase()===who)balances.set(token,(balances.get(token)??0n)-n);
      if(String(to).toLowerCase()===who)balances.set(token,(balances.get(token)??0n)+n);
    }
    return [...balances].filter(([,n])=>n>0n).map(([address,n])=>({address,balance:formatUnits(n,18)}));
  }
  candles(address,interval=60,limit=100) {
    if(![60,300,900,3600,14400,86400].includes(interval))throw new Error('Unsupported candle interval.');
    const rows=this.db.prepare('SELECT data FROM trades WHERE address=? ORDER BY height,idx').all(address.toLowerCase()),buckets=new Map();
    const compare=(a,b)=>{const scale=s=>BigInt(s.split('.')[0]+(s.split('.')[1]??'').padEnd(24,'0'));return scale(a)<scale(b);};
    for(const row of rows){const t=decode(row.data),time=Math.floor(t.timestamp/interval)*interval,p=t.priceQuote;if(p===null)continue;
      let c=buckets.get(time);if(!c){c={timestamp:time,open:p,high:p,low:p,close:p,quoteVolumeRaw:0n,tokenVolumeRaw:0n,trades:0,priceBasis:t.priceBasis};buckets.set(time,c);}
      if(compare(c.high,p))c.high=p;if(compare(p,c.low))c.low=p;c.close=p;c.quoteVolumeRaw+=BigInt(t.quoteRaw);c.tokenVolumeRaw+=BigInt(t.tokenRaw);c.trades++;
    }
    return [...buckets.values()].slice(-Math.max(1,Math.min(500,limit))).map(c=>({...c,quoteVolumeRaw:c.quoteVolumeRaw.toString(),tokenVolumeRaw:c.tokenVolumeRaw.toString()}));
  }
  status(){const tip=this.tip();return {chainId:this.chainId,factory:this.factory,indexedBlock:tip?.height??null,headBlock:this.head??null,lag:tip && this.head!==undefined?this.head-tip.height:null,confirmations:this.confirmations,finality:this.confirmations?'confirmation depth':'local provisional',error:this.lastError,backend:'SQLite WAL',adapters:['Elpida curve',this.contracts.dexPool?'Uniswap v3':'Elpida custom test pool'],tokens:this.tokens().length};}
  async close(){await this.queue;this.db.close();}
}
