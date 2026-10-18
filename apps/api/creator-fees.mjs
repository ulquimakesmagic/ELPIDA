import {Contract,Interface,ZeroAddress,formatUnits,parseUnits} from 'ethers';

// Reconstruct base fees from complete indexed curve events. Claiming never changes earnings.
export function curveCreatorEarnings(token,events){
 let reserve=0n,sold=0n,bonus=0n,earned=0n;
 const vq=BigInt(token.virtualQuote),vt=BigInt(token.virtualToken),bps=BigInt(token.feeSchedule?.base??125);
 for(const e of events){
  if(e.name==='AntiSnipeFee')bonus+=BigInt(e.args[2]);
  if(e.name==='Bought'){
   const gross=BigInt(e.args[2]),base=gross*bps/10000n;
   const tax=gross*BigInt(token.tax?.buyBps??0)/10000n;
   earned+=base-base/2n+tax-tax*3000n/10000n;reserve+=gross-base-tax-bonus;sold+=BigInt(e.args[3]);bonus=0n;
  }
  if(e.name==='Sold'){
   const input=BigInt(e.args[1]),gross=(vq+reserve)*input/(vt-sold+input),base=gross*bps/10000n;
   const tax=gross*BigInt(token.tax?.sellBps??0)/10000n;
   earned+=base-base/2n+tax-tax*3000n/10000n;reserve-=gross;sold-=input;bonus=0n;
  }
 }
 if(reserve<0n||sold<0n||bonus!==0n||(token.expectedSold!==undefined&&sold!==BigInt(token.expectedSold)))throw Error('Incomplete curve fee history.');
 return earned;
}

/** Bounded background historical reads, one job at a time; never submits transactions. */
export class CreatorFeeTotals {
 constructor(){this.jobs=new Map();this.active=false;}
 read(entry,address){
  if(this.stopping)return {status:'unavailable'};
  const index=entry.index,token=index.tokens().find(t=>t.address===address.toLowerCase()),tip=index.tip();
  if(!token||!tip)throw Error('Token history unavailable.');
  const key=`${index.chainId}:${index.factory}:${token.address}`,job=this.jobs.get(key);
  if(job?.running)return {status:'loading'};
  if(job&&Date.now()-job.at<60000)return job.result;
  if(this.active)return {status:'loading'};
  this.active=true;const next={running:true};this.jobs.set(key,next);
  next.promise=this.calculate(entry,token,tip).then(result=>next.result={status:'ready',...result}).catch(()=>next.result={status:'unavailable'}).finally(()=>{next.running=false;next.at=Date.now();this.active=false;});
  return {status:'loading'};
 }
 async close(){this.stopping=true;await Promise.all([...this.jobs.values()].map(j=>j.promise));}
 async calculate(entry,token,tip){
  const {index,provider}=entry,height=tip.height;
  const row=index.db.prepare('SELECT data FROM snapshots WHERE address=? AND height<=? ORDER BY height DESC LIMIT 1').get(token.address,height);
  if(!row)throw Error('Token snapshot unavailable.');
  const snapshot=JSON.parse(row.data);
  const events=index.db.prepare('SELECT data FROM events WHERE height<=? AND lower(json_extract(data,\'$.address\'))=? ORDER BY height,idx').all(height,token.curve.toLowerCase()).map(row=>JSON.parse(row.data));
  const curve=curveCreatorEarnings({...token,tax:snapshot.tax,expectedSold:parseUnits(snapshot.sold,18)},events),assets=new Map();
  const quote=token.quoteAddress.toLowerCase(),add=(asset,value)=>{let key=asset.toLowerCase();if(quote===ZeroAddress&&key===snapshot.quoteAsset?.toLowerCase())key=quote;assets.set(key,(assets.get(key)??0n)+value);};
  add(quote,curve);
  if(snapshot.graduated&&!snapshot.feeSplitter)throw Error('Lifetime pool fees are not indexed for this adapter.');
  if(snapshot.tax){
   const taxes=index.db.prepare("SELECT data FROM events WHERE height<=? AND lower(json_extract(data,'$.address'))=? AND json_extract(data,'$.name')='TaxPaid'").all(height,token.address.toLowerCase()).map(row=>JSON.parse(row.data));
   add(token.address,taxes.reduce((sum,e)=>sum+BigInt(e.args[2])-BigInt(e.args[3]),0n));
  }
  if(snapshot.feeSplitter&&!snapshot.tax){
   index.db.exec('CREATE TABLE IF NOT EXISTS creator_fee_totals_cache(token TEXT PRIMARY KEY,height INTEGER,hash TEXT,data TEXT)');
   const saved=index.db.prepare('SELECT * FROM creator_fee_totals_cache WHERE token=?').get(token.address);
   const locker=new Contract(snapshot.locker,['function token0() view returns(address)','function token1() view returns(address)','function collectFees() returns(uint256,uint256)'],provider);
   const [a,b]=await Promise.all([locker.token0({blockTag:height}),locker.token1({blockTag:height})]);
   let start=index.db.prepare("SELECT MIN(height) AS h FROM events WHERE lower(json_extract(data,'$.address'))=? AND json_extract(data,'$.name')='Graduated'").get(token.curve.toLowerCase()).h??token.creationBlock,settled=new Map();
   if(saved&&saved.height<=height&&(await provider.getBlock(saved.height))?.hash===saved.hash){start=saved.height+1;settled=new Map(JSON.parse(saved.data).map(([a,v])=>[a,BigInt(v)]));}
   const iface=new Interface(['event PositionFeesCollected(uint256 indexed tokenId,uint256 amount0,uint256 amount1)']);
   const topic=iface.getEvent('PositionFeesCollected').topicHash;
   // At most 200 blocks per RPC request, including on Base's public endpoint.
   for(let from=start;from<=height;from+=800){
    if(this.stopping)throw Error('Stopping.');
    const ranges=Array.from({length:4},(_,i)=>from+i*200).filter(n=>n<=height);
    const logs=(await Promise.all(ranges.map(n=>provider.getLogs({address:snapshot.locker,topics:[topic],fromBlock:n,toBlock:Math.min(height,n+199)})))).flat();
    for(const log of logs){const e=iface.parseLog(log);if(String(e.args.tokenId)!==String(snapshot.positionId))throw Error('Unexpected LP position.');for(const [asset,amount]of [[a,e.args.amount0],[b,e.args.amount1]]){const key=asset.toLowerCase();settled.set(key,(settled.get(key)??0n)+amount-amount/2n);}}
   }
   if((await provider.getBlock(height))?.hash!==tip.hash)throw Error('Fee history changed.');
   index.db.prepare('INSERT OR REPLACE INTO creator_fee_totals_cache VALUES(?,?,?,?)').run(token.address,height,tip.hash,JSON.stringify([...settled].map(([a,v])=>[a,String(v)])));
   for(const [asset,value]of settled)add(asset===ZeroAddress?quote:asset,value);
   // eth_call settles the LP position only in simulation, capturing fees not yet collected.
   const amounts=await locker.collectFees.staticCall({blockTag:height});
   add(a,amounts[0]-amounts[0]/2n);add(b,amounts[1]-amounts[1]/2n);
  }
  if((await provider.getBlock(height))?.hash!==tip.hash)throw Error('Fee history changed.');
  return {indexedBlock:height,assets:[...assets].map(([asset,value])=>{
   const isToken=asset===token.address.toLowerCase();
   if(!isToken&&asset!==quote&&!(quote===ZeroAddress&&asset===snapshot.quoteAsset?.toLowerCase()))throw Error('Unexpected fee asset.');
   return {asset,symbol:isToken?token.symbol:token.quoteSymbol,amount:formatUnits(value,isToken?18:token.quoteDecimals)};
  })};
 }
}
