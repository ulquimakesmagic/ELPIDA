import * as ethers from '/vendor/ethers.js';
import {normalizeMetadata} from './metadata.mjs';
import {prepareUploadProof} from './upload-proof.mjs';
import {allocationStatus} from './tax-allocation.mjs';
const pairAbi=['function token0() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)'];
const adapterAbi=['function dexFactory() view returns(address)','function weth() view returns(address)'];
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const dead='0x000000000000000000000000000000000000dEaD';
async function approve(w,coin,spender,amount,message,usdc=false){if(await coin.allowance(w.address,spender)<amount)await w.approvePayment(coin,spender,amount,message,usdc);}

// Public signing adapter stays disabled until this chain's complete deployment
// (factory, adapter, router and DEX domain) is explicitly registered and verified.
export async function verifyTaxDeployment(w){
 const {Contract}=ethers,d=w.net.taxDeployment;
 if(!d||!['factory','adapter','router','dexFactory','weth','treasury'].every(k=>/^0x[0-9a-f]{40}$/i.test(d[k]??'')))throw new Error('A verified V2 tax deployment is not configured on this network.');
 await w.checkNetwork();
 const f=new Contract(d.factory,w.config.contracts.taxFactory.abi,w.signer),a=new Contract(d.adapter,adapterAbi,w.provider),router=new Contract(d.router,w.config.contracts.taxRouter.abi,w.signer);
 const [version,model,automatic,treasury,adapter,dex,wrapped,routerFactory,routerWrapped,fee]=await Promise.all([f.TAX_VERSION(),f.MODEL_VERSION(),f.automaticGraduation(),f.treasury(),f.migrationAdapter(),a.dexFactory(),a.weth(),router.factory(),router.weth(),router.poolFeeBps()]);
 if(version!==1n||model!==10n||!automatic||!equal(treasury,d.treasury)||!equal(adapter,d.adapter)||!equal(dex,d.dexFactory)||!equal(wrapped,d.weth)||!equal(routerFactory,d.dexFactory)||!equal(routerWrapped,d.weth)||Number(fee)!==30)throw new Error('V2 tax deployment identity mismatch. Nothing was submitted.');
 return {factory:f,router,deployment:d};
}
export async function launchPublicTax(w,body){
 const {Contract,parseUnits,ZeroAddress}=ethers;
 const {factory, deployment:d}=await verifyTaxDeployment(w),tax=body.tax;
 if(![tax.buyBps,tax.sellBps].every(n=>Number.isInteger(n)&&n>=0&&n<=1000))throw new Error('Tax exceeds 10% or is invalid.');
 const metadata=normalizeMetadata(body),name=String(body.name??'').trim(),symbol=String(body.symbol??'').trim().toUpperCase();
 if(!name||name.length>40||!/^[A-Z0-9]{1,10}$/.test(symbol))throw new Error('Check token details.');
 const native=body.pair==='native',asset=native?ZeroAddress:body.quoteAsset;
 const quote=native?null:new Contract(asset,w.config.contracts.quote.abi,w.signer),decimals=native?18:Number(await quote.decimals());
 const buy=parseUnits(body.firstBuy||'0',decimals);if(buy<0n)throw new Error('Creator buy cannot be negative.');
 const vq=native?await factory.nativeVirtualQuote():(await factory.approvedQuotes(asset)).virtualQuote;
 if(vq===0n)throw new Error('This quote asset has no verified V2 tax adapter.');
 if(!equal(await factory.usdFeed(),w.oracle?.feed)||Number(await factory.maxPriceAge())!==w.oracle.maxAge||!equal(await factory.feeUsdc(),w.oracle.usdc??ZeroAddress))throw new Error('The tax factory oracle configuration is unverified.');
 await w.oraclePrice();
 const net=buy-buy*BigInt(125+tax.buyBps)/10000n,raw=await factory.VIRTUAL_TOKEN()*net/(vq+net),cap=759746926647958n*10n**12n,minOut=(raw>cap?cap:raw)*9950n/10000n;
 const inUsdc=body.feeCurrency==='usdc',fee=await factory.launchFee(),value=(inUsdc?0n:(fee*101n+99n)/100n)+(native?buy:0n);
 if(inUsdc&&equal(w.address,d.treasury))throw new Error('The treasury wallet must use native fee payment or a different creator wallet for this test. Nothing was submitted.');
 const payload=JSON.stringify({network:w.net.key,name,symbol,...metadata}),proof=await prepareUploadProof(payload);
 const response=await fetch('/api/metadata/stage',{method:'POST',headers:{'Content-Type':'application/json','X-Elpida-Token':w.config.csrf,...proof},body:payload});
 const published=await response.json();if(!response.ok||!/^ipfs:\/\//.test(published.uri??''))throw new Error(published.error??'Metadata staging failed.');
 const feeCoin=inUsdc?new Contract(await factory.feeUsdc(),w.config.contracts.quote.abi,w.signer):null;
 const sameCoin=quote&&feeCoin&&equal(quote.target,feeCoin.target);
 if(quote&&buy>0n&&!sameCoin)await approve(w,quote,factory.target,buy,'Approve the creator purchase…');
 if(feeCoin)await approve(w,feeCoin,factory.target,10000000n+(sameCoin?buy:0n),'Approve the exact USDC launch payment…',true);
 await w.checkNetwork();
 const params={name,symbol,asset,firstBuy:buy,minOut,uri:published.uri,feeInUsdc:inUsdc,buyTaxBps:tax.buyBps,sellTaxBps:tax.sellBps,recipients:tax.recipients,shares:tax.shares};
 await factory.launchTax.estimateGas(params,{value});
 const result=await w.wait(factory.launchTax(params,{value}),'Confirm the tax token launch and optional creator purchase…');
 const event=result.receipt?.logs?.map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Launched');
 if(!event)throw new Error('Launch submitted; refresh the verified index to recover its token address.');
 const record={address:event.args.token,curve:event.args.curve,factory:factory.target,deploymentModel:'curve-tax-v10',pair:body.pair,creator:w.address,reward:tax.recipients[0],quoteAddress:asset,quoteDecimals:decimals,quoteSymbol:native?w.net.nativeCurrency.symbol:await quote.symbol(),tax,metadata,metadataURI:published.uri,name,symbol,created:Date.now(),hash:result.tx.hash};
 w.launches.set(record.address.toLowerCase(),record);
 return {...result,hash:result.tx.hash,token:record.address,message:'Tax token launched. Creator allocations and tax rates are fixed.'};
}
export async function readTaxMarket(w,item){
 const {Contract,formatUnits,ZeroAddress}=ethers;
 const c=new Contract(item.curve,w.config.contracts.taxCurve.abi,w.provider),t=new Contract(item.address,w.config.contracts.taxToken.abi,w.provider);
 const [pool,complete,sold,reserve,held,supply,protocol,creator,reward,buy,sell,vq,vt]=await Promise.all([c.pool(),c.complete(),c.sold(),c.realReserve(),t.balanceOf(w.address),t.totalSupply(),c.protocolFees(),c.creatorFees(),c.creatorRewardVault(),t.buyTaxBps(),t.sellTaxBps(),c.virtualQuote(),c.virtualToken()]);
 const d=item.quoteDecimals??18,graduated=pool!==ZeroAddress;let rt=vt-sold,rq=vq+reserve,locked=false,tokenFirst;
 if(graduated){const p=new Contract(pool,pairAbi,w.provider),reserves=await p.getReserves();tokenFirst=equal(await p.token0(),item.address);rt=tokenFirst?reserves[0]:reserves[1];rq=tokenFirst?reserves[1]:reserves[0];const lp=await p.totalSupply(),deadLP=await p.balanceOf(dead);locked=deadLP>0n;}
 const allocations=await allocationStatus({Contract,formatUnits,provider:w.provider,address:reward,owner:w.address,quoteAsset:item.quoteAddress,quoteDecimals:d,token:item.address,curve:item.curve,curveFees:creator,recipients:item.creatorRecipients});
 return {...item,...allocations,pool,complete,graduated,liquidityLocked:locked,tokenFirst,reward,tax:{buyBps:Number(buy),sellBps:Number(sell),protocolBps:3000,creatorBps:7000},venue:graduated?'Uniswap v2':undefined,balance:formatUnits(held,18),reserve:formatUnits(graduated?rq:reserve,d),sold:formatUnits(sold,18),supply:formatUnits(supply,18),saleCap:formatUnits(await c.SALE_CAP(),18),spotPrice:Number(formatUnits(rq,d))/Number(formatUnits(rt,18)),protocolFees:formatUnits(protocol,d),creatorFees:formatUnits(creator,d),remainingBuy:complete?'0':formatUnits(await c.completionQuote(),d)};
}
export async function quoteTaxMarket(w,item,side,amount){
 const {Contract,parseUnits,formatUnits,ZeroAddress}=ethers,d=item.quoteDecimals??18;
 const c=new Contract(item.curve,w.config.contracts.taxCurve.abi,w.provider),input=parseUnits(amount,side==='buy'?d:18),buy=side==='buy';
 if(await c.pool()===ZeroAddress){const [out,fee]=buy?await c.quoteBuy(input):await c.quoteSell(input);return {out:formatUnits(out,buy?18:d),fee:formatUnits(fee,d),feeSymbol:item.quoteSymbol,feeBps:Number(buy?await c.currentFeeBps():await c.currentSellFeeBps())};}
 const {router}=await verifyTaxDeployment(w),p=new Contract(await c.pool(),pairAbi,w.provider),reserves=await p.getReserves(),first=equal(await p.token0(),item.address),rt=first?reserves[0]:reserves[1],rq=first?reserves[1]:reserves[0];
 const token=new Contract(item.address,w.config.contracts.taxToken.abi,w.provider),tax=buy?await token.buyTaxBps():await token.sellTaxBps(),taxIn=buy?0n:input*tax/10000n;
 let out=await router.quote(input-taxIn,buy?rq:rt,buy?rt:rq);if(buy)out-=out*tax/10000n;
 return {out:formatUnits(out,buy?18:d),fee:formatUnits(input*30n/10000n,buy?d:18),feeSymbol:buy?item.quoteSymbol:item.symbol,taxBps:Number(tax),feeBps:30};
}
export async function transactTaxMarket(w,item,action,body){
 const {Contract,parseUnits,ZeroAddress}=ethers;
 const {router,deployment}=await verifyTaxDeployment(w),c=new Contract(item.curve,w.config.contracts.taxCurve.abi,w.signer);
 if(action==='withdraw'){
  let result=await w.wait(c.withdrawFees(),'Claim curve fees to fixed recipients…');
  const allocation=new Contract(await c.creatorRewardVault(),w.config.contracts.creatorAllocation.abi,w.signer);
  for(const asset of [item.pair==='native'?ZeroAddress:item.quoteAddress,item.address])result=await w.wait(allocation.claim(asset,w.address),'Claim your fixed creator allocation…');
  return result;
 }
 if(action==='reopen')return w.wait(c.reopen(),'Reopen the ungraduated curve…');
 if(!['buy','sell'].includes(action))throw new Error('This token migrates within its final purchase.');
 const slippage=Number(body.slippage);if(!Number.isFinite(slippage)||slippage<0.1||slippage>5)throw new Error('Slippage must be between 0.1% and 5%.');
 const buy=action==='buy',d=item.quoteDecimals??18,input=parseUnits(body.amount,buy?d:18),q=await quoteTaxMarket(w,item,action,body.amount),minimum=parseUnits(q.out,buy?18:d)*BigInt(10000-Math.round(slippage*100))/10000n;
 const native=item.pair==='native';
 if(await c.pool()===ZeroAddress){
  if(!(buy&&native))await approve(w,new Contract(buy?item.quoteAddress:item.address,w.config.contracts.quote.abi,w.signer),c.target,input,'Approve this trade…');
  return w.wait(buy?c.buy(input,minimum,{value:native?input:0}):c.sell(input,minimum),'Confirm the curve trade…');
 }
 const quote=native?deployment.weth:item.quoteAddress,tokenIn=buy?quote:item.address,tokenOut=buy?item.address:quote;
 if(!(buy&&native))await approve(w,new Contract(tokenIn,w.config.contracts.quote.abi,w.signer),router.target,input,'Approve this trade…');
 return w.wait(router.swap(tokenIn,tokenOut,input,minimum,!buy&&native,(await w.provider.getBlock('latest')).timestamp+120,{value:buy&&native?input:0}),'Confirm the V2 trade including token tax…');
}
