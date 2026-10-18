import {readFileSync} from 'node:fs';
import {Contract,ContractFactory,ZeroAddress,parseUnits,formatUnits} from 'ethers';
import {EvmIndexer} from '../../packages/indexer/evm-indexer.mjs';
import {normalizeMetadata} from '../web/metadata.mjs';
import {allocationStatus} from '../web/tax-allocation.mjs';
import {usdQuoteTemplate,LOCAL_START_FDV_USD,SALE_CAP} from '../../packages/core/curve-model.mjs';

export async function createTaxRuntime({provider,signers,compiled,feed,coin,wrapped}){
 const artifact=n=>compiled[`contracts/evm/src/${n}.sol`][n];
 const v2=n=>JSON.parse(readFileSync(new URL(`../../node_modules/@uniswap/v2-core/build/${n}.json`,import.meta.url),'utf8'));
 const deploy=async(a,...args)=>{const c=await new ContractFactory(a.abi,a.bytecode??a.evm.bytecode.object,signers[0]).deploy(...args);await c.waitForDeployment();return c;};
 const addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const dex=await deploy(v2('UniswapV2Factory'),addresses[2]);
 const adapter=await deploy(artifact('ElpidaV2TaxMigrationAdapter'),dex.target,wrapped.target,coin.target);
 const router=await deploy(artifact('ElpidaV2TaxRouter'),dex.target,wrapped.target,30);
 const factory=await deploy(artifact('ElpidaTaxFactory'),addresses[2],adapter.target,LOCAL_START_FDV_USD,86400);
 await (await factory.connect(signers[2]).configureUsdPricing(feed.target,86400,coin.target)).wait();
 await (await factory.connect(signers[2]).approveQuote(coin.target,usdQuoteTemplate(LOCAL_START_FDV_USD,6),adapter.target)).wait();
 const start=await provider.getBlockNumber();
 const contracts={tax:true,factory:artifact('ElpidaTaxFactory'),curve:artifact('ElpidaTaxCurve'),token:artifact('ElpidaTaxToken'),pool:v2('UniswapV2Pair'),dexPool:v2('UniswapV2Pair')};
 const index=new EvmIndexer({provider,factory:factory.target,contracts,fromBlock:start});
 const records=new Map(),meta=new Map();
 const record=token=>records.get(String(token).toLowerCase());
 async function launch(body,signer){
  const details=normalizeMetadata(body),name=String(body.name??'').trim(),symbol=String(body.symbol??'').trim().toUpperCase();
  if(!name||name.length>40||!/^[A-Z0-9]{1,10}$/.test(symbol))throw new Error('Check the token name and symbol.');
  if(!['native','usdc'].includes(body.pair??'native'))throw new Error('Tax rehearsals currently support native and USDC quote pairs.');
  if(body.rewardPolicy?.mode&&body.rewardPolicy.mode!=='creator')throw new Error('Tax launches currently support creator wallet allocations.');
  const native=(body.pair??'native')==='native',asset=native?ZeroAddress:coin.target,d=native?18:6,buy=parseUnits(body.firstBuy||'0',d);
  if(buy<0n)throw new Error('Creator purchase cannot be negative.');
  const owner=await signer.getAddress(),tax=body.tax;
  if(![tax.buyBps,tax.sellBps].every(n=>Number.isInteger(n)&&n>=0&&n<=1000))throw new Error('Tax rates must be integer basis points from 0 to 1000.');
  const vq=native?await factory.nativeVirtualQuote():(await factory.approvedQuotes(asset)).virtualQuote;
  const net=buy-buy*BigInt(125+tax.buyBps)/10000n,raw=await factory.VIRTUAL_TOKEN()*net/(vq+net),expected=raw>SALE_CAP?SALE_CAP:raw;
  const fee=await factory.launchFee(),inUsdc=body.feeCurrency==='usdc';
  if(inUsdc)await (await coin.connect(signer).approve(factory.target,10000000n+(native?0n:buy))).wait();
  if(!native&&!inUsdc&&buy>0n)await (await coin.connect(signer).approve(factory.target,buy)).wait();
  const params={name,symbol,asset,firstBuy:buy,minOut:expected*9950n/10000n,uri:'',feeInUsdc:inUsdc,buyTaxBps:tax.buyBps,sellTaxBps:tax.sellBps,recipients:tax.recipients,shares:tax.shares};
  // The contract enforces bounds and allocations as well as the launch form.
  const tx=await factory.connect(signer).launchTax(params,{value:(inUsdc?0n:fee)+(native?buy:0n)}),receipt=await tx.wait();
  const event=receipt.logs.map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Launched');
  const token=event.args.token.toLowerCase();records.set(token,{curve:event.args.curve,native,tax,quote:native?wrapped.target:coin.target,d});
  meta.set(tx.hash,details);
  await index.sync();return {hash:tx.hash,token,message:'Tax token launched on the local V2 rehearsal. Tax rates and creator wallets are fixed.'};
 }
 async function quote(body){
  const r=record(body.token),c=new Contract(r.curve,contracts.curve.abi,provider),input=parseUnits(body.amount,body.side==='buy'?r.d:18);
  if(await c.pool()===ZeroAddress){const [out,fee]=body.side==='buy'?await c.quoteBuy(input):await c.quoteSell(input);return {out:formatUnits(out,body.side==='buy'?18:r.d),fee:formatUnits(fee,r.d),feeBps:Number(body.side==='buy'?await c.currentFeeBps():await c.currentSellFeeBps()),quoteSymbol:r.native?'ETH':'USDC'};}
  const pair=new Contract(await c.pool(),contracts.pool.abi,provider),reserves=await pair.getReserves(),first=(await pair.token0()).toLowerCase()===body.token.toLowerCase();
  const rt=first?reserves[0]:reserves[1],rq=first?reserves[1]:reserves[0],buy=body.side==='buy';
  const taxInput=buy?0n:input*BigInt(r.tax.sellBps)/10000n;
  let out=await router.quote(input-taxInput,buy?rq:rt,buy?rt:rq);
  const taxOutput=buy?out*BigInt(r.tax.buyBps)/10000n:0n;out-=taxOutput;
  return {out:formatUnits(out,buy?18:r.d),fee:formatUnits(input*30n/10000n,buy?r.d:18),feeBps:30,taxBps:buy?r.tax.buyBps:r.tax.sellBps,taxAmount:formatUnits(buy?taxOutput:taxInput,18),quoteSymbol:r.native?'ETH':'USDC'};
 }
 async function execute(action,body,signer){
  const r=record(body.token),c=new Contract(r.curve,contracts.curve.abi,signer),owner=await signer.getAddress();
  if(action==='withdraw'){
   await (await c.withdrawFees()).wait();
   const allocation=new Contract(await c.creatorRewardVault(),artifact('ElpidaCreatorAllocation').abi,signer);
   for(const asset of [r.native?ZeroAddress:coin.target,body.token])await (await allocation.claim(asset,owner)).wait();
   return {message:'Creator allocations claimed to the fixed wallet.'};
  }
  if(!['buy','sell'].includes(action))throw new Error('Tax market action unavailable.');
  const input=parseUnits(body.amount,action==='buy'?r.d:18),q=await quote({...body,side:action}),min=parseUnits(q.out,action==='buy'?18:r.d)*9900n/10000n;
  let tx;
  if(await c.pool()===ZeroAddress){
   if(action==='sell')await (await new Contract(body.token,contracts.token.abi,signer).approve(c.target,input)).wait();
   if(action==='buy'&&!r.native)await (await coin.connect(signer).approve(c.target,input)).wait();
   tx=action==='buy'?await c.buy(input,min,{value:r.native?input:0}):await c.sell(input,min);
  }else{
   const tokenIn=action==='buy'?r.quote:body.token,tokenOut=action==='buy'?body.token:r.quote;
   if(!(action==='buy'&&r.native))await (await new Contract(tokenIn,['function approve(address,uint256) returns(bool)'],signer).approve(router.target,input)).wait();
   tx=await router.connect(signer).swap(tokenIn,tokenOut,input,min,action==='sell'&&r.native,(await provider.getBlock('latest')).timestamp+120,{value:action==='buy'&&r.native?input:0});
  }
  await tx.wait();await index.sync();return {hash:tx.hash,message:'Tax trade confirmed with the quoted minimum received.'};
 }
 const walletRewards=(row,owner)=>allocationStatus({Contract,formatUnits,provider,address:row.reward,owner,quoteAsset:row.quoteAddress,quoteDecimals:row.quoteDecimals,token:row.address,curve:row.curve,curveFees:parseUnits(row.creatorFees,row.quoteDecimals),recipients:row.creatorRecipients});
 return {index,record,launch,quote,execute,walletRewards,config:{factory:factory.target,adapter:adapter.target,router:router.target,dexFactory:dex.target,wrapped:wrapped.target},listings:()=>index.listings().map(t=>({...t,metadata:meta.get(t.hash)??{},factory:factory.target})),close:()=>index.close()};
}
