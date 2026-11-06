import test from 'node:test';
import assert from 'node:assert/strict';
import {usdReferenceFor} from '../packages/core/pairs.mjs';
import {restoreTradeDraft} from '../apps/web/trade-draft.mjs';
const now=1800000000,stock={provider:'ondo-test',price:'180',updatedAt:now-60,paused:false,marketStatus:'open',feed:'test-feed'},token={network:'ethereum-sepolia',pair:'xstock',stock};
test('simulated stock feeds on testnets become USD references, however long ago they were set',()=>{
 const ref=usdReferenceFor(token,null,now);assert.equal(ref.usd,180);assert.match(ref.source,/Simulated/);assert.equal(ref.updatedAt,now-60);
 for(const change of [{paused:true},{price:0},{price:'Infinity'},{updatedAt:now+301},{marketStatus:'corporate-action'},{marketStatus:'unknown'}])assert.equal(usdReferenceFor({...token,stock:{...stock,...change}},null,now),null);
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
