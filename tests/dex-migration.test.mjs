import test from 'node:test';
import assert from 'node:assert/strict';
import {Contract,parseUnits,parseEther,ZeroAddress} from 'ethers';
import {v3Artifacts} from '../packages/core/uniswap.mjs';
import {rawCid} from '../apps/api/metadata-store.mjs';
import {dexFixture,launch,complete,mined,art,FEE,parse,poolPrice,sortPair} from './helpers/dex-fixture.mjs';
// DEX launchpad (ElpidaDexFactory, model 10): native pricing. Native pairs graduate through a WETH adapter;
// the ERC-20 path is an approved paired asset (mock USDC) whose creation fee is still native.

test('metadata is immutable, emitted with creation, and rolls back with a failed first buy',async t=>{
 const f=await dexFixture(t),uri='ipfs://'+rawCid(Buffer.from('metadata')),buy=parseEther('0.01');
 const before=await f.provider.getBalance(f.addresses[2]);
 await assert.rejects(f.factory.launchWithMetadata.staticCall('Invalid','BAD',buy,0,f.addresses[0],'https://example.com',{value:FEE+buy}),/IPFS URI/);
 await assert.rejects(f.factory.launchWithMetadata.staticCall('Failed','BAD',buy,parseUnits('1000000000',18),f.addresses[0],uri,{value:FEE+buy}),/revert|slippage/);
 assert.equal(await f.provider.getBalance(f.addresses[2]),before);assert.equal((await f.factory.queryFilter(f.factory.filters.MetadataPublished())).length,0);
 const receipt=await mined(f.factory.launchWithMetadata('Shared','SHARED',buy,0,f.addresses[0],uri,{value:FEE+buy}));
 assert.equal(await f.provider.getBalance(f.addresses[2])-before,FEE,'native creation fee');
 const [launch_]=parse(f.factory,receipt,'Launched'),[metadata]=parse(f.factory,receipt,'MetadataPublished');
 assert.equal(metadata.args.token,launch_.args.token);assert.equal(metadata.args.uri,uri);assert.equal(await f.factory.tokenMetadataURI(launch_.args.token),uri);assert.equal(await f.factory.METADATA_VERSION(),1n);
 // D11: the only state-changing entry points are the launch functions (which write metadata for the token they
 // just created) and treasury configuration. No function takes an existing token and a URI.
 const writable=f.factory.interface.fragments.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).map(x=>x.name).sort();
 assert.deepEqual(writable,['approveQuote','configureUsdPricing','launch','launchPaired','launchPairedWithMetadata','launchWithMetadata','launchWithPayment']);
 // A second launch with a different URI cannot touch the first token's metadata.
 const other='ipfs://'+rawCid(Buffer.from('other'));await mined(f.factory.launchWithMetadata('Second','TWO',buy,0,f.addresses[0],other,{value:FEE+buy}));
 assert.equal(await f.factory.tokenMetadataURI(launch_.args.token),uri);
});

for(const native of [true,false])test('actual Uniswap v3 graduation + swaps + permanent fee split: '+(native?'ETH':'USDC'),async t=>{
 const f=await dexFixture(t),l=await launch(f,{native});
 await complete(f,l);
 const terminal=(await l.curve.virtualQuote()+await l.curve.realReserve())*10n**30n/(await l.curve.virtualToken()-await l.curve.sold());
 // A third party can initialize an empty pool at a wrong price; the adapter must restore the terminal price.
 const {tokenFirst,a,b}=sortPair(l.token.target,l.quote);
 await mined(f.dex.manager.createAndInitializePoolIfNecessary(a,b,10000,2n**96n));
 await mined(l.curve.graduate());
 const pool=new Contract(await l.curve.pool(),v3Artifacts.pool.abi,f.provider),locker=new Contract(await l.curve.locker(),art('ElpidaV3FeeLocker').abi,f.signers[0]),splitter=new Contract(await l.curve.feeSplitter(),art('ElpidaFeeSplitter').abi,f.signers[0]);
 assert.equal(await f.dex.manager.ownerOf(await l.curve.positionId()),locker.target);assert.equal(await locker.locked(),true);const principal=(await f.dex.manager.positions(await l.curve.positionId())).liquidity;
 assert.ok(principal>0n);assert.equal(await l.curve.realReserve(),0n);await assert.rejects(l.curve.graduate.staticCall(),/already migrated/);
 const actual=await poolPrice(pool,tokenFirst);assert.ok((actual>terminal?actual-terminal:terminal-actual)*1000000n<=terminal,'terminal price continuity');
 const buy=parseUnits(native?'0.1':'100',native?18:6);if(!native)await mined(f.usdc.approve(f.dex.router.target,buy));
 const params={tokenIn:l.quote,tokenOut:l.token.target,fee:10000,recipient:f.addresses[0],deadline:Math.floor(Date.now()/1000)+3600,amountIn:buy,amountOutMinimum:0,sqrtPriceLimitX96:0};
 await mined(f.dex.router.exactInputSingle(params,{value:native?buy:0}));
 const sell=parseUnits('1000000',18);await mined(l.token.approve(f.dex.router.target,sell));await mined(f.dex.router.exactInputSingle({...params,tokenIn:l.token.target,tokenOut:l.quote,amountIn:sell}));
 await mined(locker.collectFees());assert.equal((await f.dex.manager.positions(await l.curve.positionId())).liquidity,principal);
 for(const asset of [a,b]){const treasury=await splitter.claimable(asset,f.addresses[2]),creator=await splitter.claimable(asset,f.addresses[0]);assert.ok(treasury>0n);assert.ok(creator===treasury||creator===treasury+1n);await mined(splitter.claim(asset,f.addresses[0]));await mined(splitter.claim(asset,f.addresses[2]));assert.equal(await splitter.claimable(asset,f.addresses[0]),0n);}
 await assert.rejects(f.dex.manager.decreaseLiquidity.staticCall({tokenId:await l.curve.positionId(),liquidity:principal,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+3600}),/revert|approved|owner/);
 assert.equal(await f.dex.manager.ownerOf(await l.curve.positionId()),locker.target);
});
