import test from 'node:test';
import assert from 'node:assert/strict';
import {network} from 'hardhat';
import {BrowserProvider,Contract,ContractFactory,parseUnits,parseEther,ZeroAddress} from 'ethers';
import {compileContracts} from '../scripts/compile.mjs';
import {deployLocalV3,v3Artifacts} from '../packages/core/uniswap.mjs';
import {rawCid} from '../apps/api/metadata-store.mjs';
// DEX launchpad (ElpidaDexFactory, model 7): native pricing. Native pairs graduate through a WETH adapter;
// the ERC-20 path is an approved paired token (a 6-decimal mock asset) whose creation fee is still native.
const compiled=compileContracts({includeMocks:true}),art=n=>compiled['contracts/evm/src/'+n+'.sol'][n],mined=async p=>(await p).wait();
const FEE=parseEther('0.004');
async function fixture(t){
 const connection=await network.create('localTest'),provider=new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;t.after(async()=>{provider.destroy();await connection.close();});
 const signers=await Promise.all([0,1,2].map(i=>provider.getSigner(i))),addresses=await Promise.all(signers.map(s=>s.getAddress()));
 const deploy=async(a,...args)=>{const c=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(...args);await c.waitForDeployment();return c;};
 const usdc=await deploy(compiled['tests/fixtures/MockUSDC.sol'].MockUSDC),dex=await deployLocalV3(signers[0],compiled['tests/fixtures/LocalWrappedETH.sol'].LocalWrappedETH);
 const nativeAdapter=await deploy(art('ElpidaV3MigrationAdapter'),dex.manager.target,dex.weth.target,10000);
 const factory=await deploy(art('ElpidaDexFactory'),addresses[2],FEE,parseUnits('2.133333333333333333',18),nativeAdapter.target);
 const feedA=compiled['tests/fixtures/MockUsdFeed.sol'].MockUsdFeed,feed=await new ContractFactory(feedA.abi,feedA.evm.bytecode.object,signers[0]).deploy(2500n*10n**8n);await feed.waitForDeployment();
 await mined(factory.connect(signers[2]).configureUsdPricing(feed.target,86400,ZeroAddress));
 // The paired asset needs its own adapter and a treasury-approved template.
 const adapter=await deploy(art('ElpidaV3MigrationAdapter'),dex.manager.target,usdc.target,10000);
 await mined(factory.connect(signers[2]).approveQuote(usdc.target,parseUnits('5333.333333',6),adapter.target));
 await mined(usdc.mint(addresses[0],parseUnits('100000',6)));return {provider,signers,addresses,usdc,dex,adapter,nativeAdapter,factory};
}
test('metadata is immutable, emitted with creation, and rolls back with a failed first buy',async t=>{
 const f=await fixture(t),uri='ipfs://'+rawCid(Buffer.from('metadata')),buy=parseEther('0.01');
 const before=await f.provider.getBalance(f.addresses[2]);
 await assert.rejects(f.factory.launchWithMetadata.staticCall('Invalid','BAD',buy,0,f.addresses[0],'https://example.com',{value:FEE+buy}),/IPFS URI/);
 await assert.rejects(f.factory.launchWithMetadata.staticCall('Failed','BAD',buy,parseUnits('1000000000',18),f.addresses[0],uri,{value:FEE+buy}),/revert|slippage/);
 assert.equal(await f.provider.getBalance(f.addresses[2]),before);assert.equal((await f.factory.queryFilter(f.factory.filters.MetadataPublished())).length,0);
 const receipt=await mined(f.factory.launchWithMetadata('Shared','SHARED',buy,0,f.addresses[0],uri,{value:FEE+buy}));
 assert.equal(await f.provider.getBalance(f.addresses[2])-before,FEE,'native creation fee');
 const events=receipt.logs.map(log=>{try{return f.factory.interface.parseLog(log);}catch{return null;}}),launch=events.find(e=>e?.name==='Launched'),metadata=events.find(e=>e?.name==='MetadataPublished');
 assert.equal(metadata.args.token,launch.args.token);assert.equal(metadata.args.uri,uri);assert.equal(await f.factory.tokenMetadataURI(launch.args.token),uri);assert.equal(await f.factory.METADATA_VERSION(),1n);
 assert.ok(!f.factory.interface.fragments.some(f=>f.type==='function'&&/^set.*metadata/i.test(f.name)));
});
for(const native of [true,false])test('actual Uniswap v3 graduation + swaps + permanent fee split: '+(native?'ETH':'paired token'),async t=>{
 const f=await fixture(t),first=parseUnits(native?'0.01':'100',native?18:6);
 await mined(f.usdc.approve(f.factory.target,parseUnits('100000',6)));
 const treasuryBefore=await f.provider.getBalance(f.addresses[2]);
 const receipt=await mined(native?f.factory.launch('DEX demo','DEX',first,0,f.addresses[0],{value:FEE+first}):f.factory.launchPaired('DEX demo','DEX',f.usdc.target,first,0,f.addresses[0],{value:FEE}));
 assert.equal(await f.provider.getBalance(f.addresses[2])-treasuryBefore,FEE,'creation fee in ETH whatever the pair');
 if(!native)await assert.rejects(f.factory.launchPaired.staticCall('X','X',f.usdc.target,first,0,f.addresses[0]),/FeeQuoteMoved/);
 const ev=receipt.logs.map(l=>{try{return f.factory.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Launched');
 const curve=new Contract(ev.args.curve,art('ElpidaDexCurve').abi,f.signers[0]),token=new Contract(ev.args.token,art('ElpidaToken').abi,f.signers[0]);
 const remaining=await curve.completionQuote();if(!native)await mined(f.usdc.approve(curve.target,remaining));await mined(curve.buy(remaining,0,{value:native?remaining:0}));
 const beforePrice=await curve.virtualQuote()+await curve.realReserve(),denominator=await curve.virtualToken()-await curve.sold();
 // A third party can initialize an empty pool at a wrong price; adapter must restore terminal price.
 const quote=native?f.dex.weth.target:f.usdc.target,firstAsset=BigInt(token.target)<BigInt(quote),a=firstAsset?token.target:quote,b=firstAsset?quote:token.target;
 await mined(f.dex.manager.createAndInitializePoolIfNecessary(a,b,10000,2n**96n));
 await mined(curve.graduate());
 const pool=new Contract(await curve.pool(),v3Artifacts.pool.abi,f.provider),locker=new Contract(await curve.locker(),art('ElpidaV3FeeLocker').abi,f.signers[0]),splitter=new Contract(await curve.feeSplitter(),art('ElpidaFeeSplitter').abi,f.signers[0]);
 assert.equal(await f.dex.manager.ownerOf(await curve.positionId()),locker.target);assert.equal(await locker.locked(),true);const principal=(await f.dex.manager.positions(await curve.positionId())).liquidity;
 assert.ok(principal>0n);assert.equal(await curve.realReserve(),0n);await assert.rejects(curve.graduate.staticCall(),/already migrated/);
 const sqrt=(await pool.slot0()).sqrtPriceX96;const num=firstAsset?sqrt*sqrt:2n**192n,den=firstAsset?2n**192n:sqrt*sqrt;
 const scale=10n**30n,actual=num*scale/den,expected=beforePrice*scale/denominator;assert.ok((actual>expected?actual-expected:expected-actual)*1000000n<=expected,'terminal price continuity');
 const buy=parseUnits(native?'0.1':'100',native?18:6);if(!native)await mined(f.usdc.approve(f.dex.router.target,buy));
 const params={tokenIn:quote,tokenOut:token.target,fee:10000,recipient:f.addresses[0],deadline:Math.floor(Date.now()/1000)+3600,amountIn:buy,amountOutMinimum:0,sqrtPriceLimitX96:0};
 await mined(f.dex.router.exactInputSingle(params,{value:native?buy:0}));
 const sell=parseUnits('1000000',18);await mined(token.approve(f.dex.router.target,sell));await mined(f.dex.router.exactInputSingle({...params,tokenIn:token.target,tokenOut:quote,amountIn:sell}));
 await mined(locker.collectFees());assert.equal((await f.dex.manager.positions(await curve.positionId())).liquidity,principal);
 for(const asset of [a,b]){const treasury=await splitter.claimable(asset,f.addresses[2]),creator=await splitter.claimable(asset,f.addresses[0]);assert.ok(treasury>0n);assert.ok(creator===treasury||creator===treasury+1n);await mined(splitter.claim(asset,f.addresses[0]));await mined(splitter.claim(asset,f.addresses[2]));assert.equal(await splitter.claimable(asset,f.addresses[0]),0n);}
 await assert.rejects(f.dex.manager.decreaseLiquidity.staticCall({tokenId:await curve.positionId(),liquidity:principal,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+3600}),/revert|approved|owner/);
 assert.equal(await f.dex.manager.ownerOf(await curve.positionId()),locker.target);
});

test('active mismatched pool rejects migration atomically without losing curve reserves',async t=>{
 const f=await fixture(t);await mined(f.usdc.approve(f.factory.target,parseUnits('100000',6)));
 const receipt=await mined(f.factory.launchPaired('Protected migration','SAFE',f.usdc.target,parseUnits('100',6),0,f.addresses[0],{value:FEE}));const ev=receipt.logs.map(l=>{try{return f.factory.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Launched');
 const curve=new Contract(ev.args.curve,art('ElpidaDexCurve').abi,f.signers[0]),token=new Contract(ev.args.token,art('ElpidaToken').abi,f.signers[0]);
 const remaining=await curve.completionQuote();await mined(f.usdc.approve(curve.target,remaining));await mined(curve.buy(remaining,0));
 const first=BigInt(token.target)<BigInt(f.usdc.target),a=first?token.target:f.usdc.target,b=first?f.usdc.target:token.target;
 await mined(f.dex.manager.createAndInitializePoolIfNecessary(a,b,10000,2n**96n));await mined(token.approve(f.dex.manager.target,1000000));await mined(f.usdc.approve(f.dex.manager.target,1000000));
 await mined(f.dex.manager.mint({token0:a,token1:b,fee:10000,tickLower:-887200,tickUpper:887200,amount0Desired:1000000,amount1Desired:1000000,amount0Min:0,amount1Min:0,recipient:f.addresses[0],deadline:Math.floor(Date.now()/1000)+3600}));
 const reserve=await curve.realReserve(),tokens=await token.balanceOf(curve.target),quote=await f.usdc.balanceOf(curve.target);
 await assert.rejects(curve.graduate.staticCall(),/pool price mismatch/);
 const failed=await curve.graduate({gasLimit:9000000});await assert.rejects(failed.wait(),/revert/);
 assert.equal(await curve.pool(),ZeroAddress);assert.equal(await curve.realReserve(),reserve);assert.equal(await token.balanceOf(curve.target),tokens);assert.equal(await f.usdc.balanceOf(curve.target),quote);assert.equal(await token.allowance(curve.target,f.adapter.target),0n);
});
