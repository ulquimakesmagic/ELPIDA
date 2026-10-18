// Shared model 10 test fixture: a local chain with real Uniswap v3, a USD feed, mock USDC and the DEX launchpad.
import {network} from 'hardhat';
import {BrowserProvider,Contract,ContractFactory,parseUnits,parseEther,ZeroAddress} from 'ethers';
import {compileContracts} from '../../scripts/compile.mjs';
import {deployLocalV3} from '../../packages/core/uniswap.mjs';
import {usdQuoteTemplate,GRADUATION_GRACE_SECONDS} from '../../packages/core/curve-model.mjs';

export const compiled=compileContracts({includeMocks:true});
export const art=n=>compiled['contracts/evm/src/'+n+'.sol'][n];
export const fixtureArt=(file,n=file)=>compiled['tests/fixtures/'+file+'.sol'][n];
export const mined=async p=>(await p).wait();
export const ETH_USD=2500n;
/** $10 at $2,500 per ETH. */
export const FEE=parseEther('0.004');

export async function dexFixture(t,{startFdvUsd=5000,grace=GRADUATION_GRACE_SECONDS,factoryName='ElpidaDexFactory'}={}){
 const connection=await network.create('localTest'),provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;t.after(async()=>{provider.destroy();await connection.close();});
 const signers=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i))),addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const deploy=async(a,...args)=>{const c=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(...args);await c.waitForDeployment();return c;};
 const usdc=await deploy(fixtureArt('MockUSDC')),dex=await deployLocalV3(signers[0],fixtureArt('LocalWrappedETH'));
 const nativeAdapter=await deploy(art('ElpidaV3MigrationAdapter'),dex.manager.target,dex.weth.target,10000);
 const factory=await deploy(art(factoryName),addresses[2],nativeAdapter.target,startFdvUsd,grace);
 const feed=await deploy(fixtureArt('MockUsdFeed'),ETH_USD*10n**8n);
 await mined(factory.connect(signers[2]).configureUsdPricing(feed.target,86400,ZeroAddress));
 const adapter=await deploy(art('ElpidaV3MigrationAdapter'),dex.manager.target,usdc.target,10000);
 await mined(factory.connect(signers[2]).approveQuote(usdc.target,usdQuoteTemplate(startFdvUsd,6),adapter.target));
 for(const a of addresses.slice(0,2))await mined(usdc.mint(a,parseUnits('1000000',6)));
 const f={provider,signers,addresses,usdc,dex,adapter,nativeAdapter,factory,feed,deploy,startFdvUsd,grace};
 f.now=async()=>(await provider.getBlock('latest')).timestamp;
 f.at=async seconds=>{await provider.send('evm_setNextBlockTimestamp',[seconds]);};
 f.advance=async seconds=>{await provider.send('evm_increaseTime',[seconds]);await provider.send('evm_mine',[]);};
 /** Keeps the oracle fresh after time travel. */
 f.refreshFeed=async()=>{const r=await feed.roundId()+1n;await mined(feed.set(ETH_USD*10n**8n,await f.now(),r,r));};
 return f;
}

export function parse(contract,receipt,name){return receipt.logs.map(l=>{try{return contract.interface.parseLog(l);}catch{return null;}}).filter(e=>e?.name===name);}

/** Launches a token. `native` true pays and pairs in ETH; false pairs with mock USDC. */
export async function launch(f,{native=true,firstBuy,reward,signer=f.signers[0],name='Hope',symbol='HOPE'}={}){
 const buy=firstBuy??(native?parseEther('0.01'):parseUnits('100',6));
 if(!native)await mined(f.usdc.connect(signer).approve(f.factory.target,buy));
 const receipt=await mined(native?f.factory.connect(signer).launch(name,symbol,buy,0,reward??f.addresses[0],{value:FEE+buy}):f.factory.connect(signer).launchPaired(name,symbol,f.usdc.target,buy,0,reward??f.addresses[0],{value:FEE}));
 const [ev]=parse(f.factory,receipt,'Launched');
 return {receipt,curve:new Contract(ev.args.curve,art('ElpidaDexCurve').abi,signer),token:new Contract(ev.args.token,art('ElpidaToken').abi,signer),quote:native?f.dex.weth.target:f.usdc.target,native};
}

/** Buys out the rest of the curve after the anti-snipe window (so no bonus unless `early`). */
export async function complete(f,l,{signer=f.signers[0],early=false}={}){
 if(!early){const launched=Number(await l.curve.launchedAt()),now=await f.now();if(now<launched+60)await f.advance(launched+61-now);}
 // One second of slack: the fee schedule is evaluated in the next block.
 const gross=await l.curve.completionQuote();
 if(!l.native)await mined(f.usdc.connect(signer).approve(l.curve.target,gross));
 await mined(l.curve.connect(signer).buy(gross,0,{value:l.native?gross:0n}));
 return gross;
}

/** Quote-asset balance held by a curve (native ETH or the ERC-20 quote). */
export async function quoteBalance(f,l){return l.native?f.provider.getBalance(l.curve.target):f.usdc.balanceOf(l.curve.target);}

/** Curve liabilities: real reserve, both owed fee balances and the locked anti-snipe bonus. */
export async function liabilities(l){return await l.curve.realReserve()+await l.curve.protocolFees()+await l.curve.creatorFees()+await l.curve.liquidityBonus();}

/** Pool price as quote raw units per token raw unit, scaled by 1e30. */
export async function poolPrice(pool,tokenFirst){
 const sqrt=(await pool.slot0()).sqrtPriceX96,num=tokenFirst?sqrt*sqrt:2n**192n,den=tokenFirst?2n**192n:sqrt*sqrt;
 return num*10n**30n/den;
}
export const sortPair=(token,quote)=>{const first=BigInt(token)<BigInt(quote);return {tokenFirst:first,a:first?token:quote,b:first?quote:token};};
