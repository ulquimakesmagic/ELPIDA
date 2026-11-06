import test from 'node:test';
import assert from 'node:assert/strict';
import {usdReferenceFor} from '../packages/core/pairs.mjs';
import {restoreTradeDraft} from '../apps/web/trade-draft.mjs';
const now=1800000000,stock={provider:'ondo-test',price:'180',updatedAt:now-60,paused:false,marketStatus:'open',feed:'test-feed'},token={network:'ethereum-sepolia',pair:'xstock',stock};
test('simulated stock feeds on testnets become USD references, however long ago they were set',()=>{
 const ref=usdReferenceFor(token,null,now);assert.equal(ref.usd,180);assert.match(ref.source,/Simulated/);assert.equal(ref.updatedAt,now-60);
 for(const change of [{price:0},{price:'Infinity'},{updatedAt:now+301}])assert.equal(usdReferenceFor({...token,stock:{...stock,...change}},null,now),null);
 // 6 November 2026: a paused stock or one in a corporate action still has its last price on screen (dollars only);
 // the launch and trade gates check the issuer's controls themselves.
 for(const change of [{paused:true},{marketStatus:'corporate-action'}])assert.equal(usdReferenceFor({...token,stock:{...stock,...change}},null,now).usd,180);
 for(const network of ['ethereum','ethereum-mainnet',undefined])assert.equal(usdReferenceFor({...token,network},null,now),null);
 assert.equal(usdReferenceFor({...token,stock:{...stock,provider:'ondo'}},null,now),null);
 assert.equal(usdReferenceFor({...token,stock:{...stock,marketStatus:'closed'}},null,now).usd,180);
 // 5 November 2026: a test feed not set for days still values its pairs on screen, saying when it was last set.
 const old=usdReferenceFor({...token,stock:{...stock,updatedAt:now-5*86400}},null,now);
 assert.equal(old.usd,180);assert.equal(old.updatedAt,now);assert.match(old.source,/last set .* UTC \(no monetary value\)/);
});
test('background draft restores currency before amount, and refuses a different wallet/chain/token',()=>{
 const calls=[],input={dataset:{context:'wallet:chain:token'},value:'',dispatchEvent:e=>calls.push([e.type,input.value])},slippage={disabled:false,value:'1',dispatchEvent:()=>{}},panel={selectSide:(s,options)=>calls.push(['side',s,options.focus]),selectCurrency:s=>calls.push(['currency',s])};
 const previous={context:input.dataset.context,side:'sell',settlement:'native',amount:'0.001',slippage:'0.5'};
 assert.equal(restoreTradeDraft(previous,{input,slippage,panel}),true);assert.deepEqual(calls,[['side','sell',false],['currency','native'],['input','0.001']]);
 calls.length=0;input.value='';assert.equal(restoreTradeDraft({...previous,context:'other-wallet'},{input,slippage,panel}),false);assert.equal(input.value,'');assert.equal(calls.length,0);
});

test('labelled test pair assets with no market are valued at the price their pair approval implies (test networks only)',async()=>{
 const {testPairReference}=await import('../packages/core/pairs.mjs');
 const meme=testPairReference({network:'base-sepolia',pair:'token',quoteSymbol:'TEST-MEME'},now);
 assert.equal(meme.usd,50/500000);assert.match(meme.source,/no monetary value/);
 assert.equal(testPairReference({network:'base-sepolia',pair:'xstock',quoteSymbol:'tNVDAon'},now).usd,180);
 assert.equal(testPairReference({network:'base-sepolia',pair:'xstock',quoteSymbol:'TEST-STOCK'},now).usd,2.5);
 assert.equal(testPairReference({network:'ethereum',pair:'token',quoteSymbol:'TEST-MEME'},now),null,'never on mainnet');
 assert.equal(testPairReference({network:'base-sepolia',pair:'token',quoteSymbol:'SOMETHING'},now),null);
 const {pairTokenReferences}=await import('../apps/web/discovery.mjs');
 const quote={network:'base-sepolia',address:'0xAA',symbol:'HOPE',spotPrice:'0.002',usdReference:{status:'fresh',usd:3000,updatedAt:now,maxAge:60,source:'Pyth'}};
 const [,paired]=pairTokenReferences([quote,{network:'base-sepolia',address:'0xbb',pair:'token',quoteAddress:'0xaa'}]);
 assert.equal(paired.usdReference.usd,6);assert.match(paired.usdReference.source,/HOPE market price/);
});
