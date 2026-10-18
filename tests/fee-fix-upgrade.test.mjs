import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DEX_MODEL,isDexModel} from '../packages/core/curve-model.mjs';

const source=readFileSync(new URL('../apps/web/wallet.mjs',import.meta.url),'utf8');
function fixture(net,saved,revision){
 const getters=source.slice(source.indexOf('  get deployment()'),source.indexOf("  /** A token's own curve model:"));
 const context={read:()=>saved,deploymentKey:()=>'',modelOf:()=>DEX_MODEL,isDexModel,DEX_MODEL,LEGACY_DEX_MODEL:'curve-dex-v9'};
 vm.runInNewContext('class Wallet { '+getters+' }; globalThis.Wallet=Wallet;',context);
 const w=new context.Wallet();Object.assign(w,{net,model:DEX_MODEL,dex:{},feeAccountingVersion:revision});return w;
}
test('only a confirmed old Base Sepolia accounting revision offers replacement',()=>{
 const shared={factory:'old',model:DEX_MODEL},net={key:'base-sepolia',chainId:84532,shared};
 assert.equal(fixture(net,null,0).feeFixUpgradeAvailable,true);
 assert.equal(fixture(net,null,undefined).feeFixUpgradeAvailable,false);
 assert.equal(fixture(net,null,1).feeFixUpgradeAvailable,false);
 assert.equal(fixture({...net,key:'base',chainId:8453},null,0).feeFixUpgradeAvailable,false);
});
test('a corrected browser deployment survives reload until the team registry is updated',()=>{
 const old={factory:'old',model:DEX_MODEL},saved={factory:'corrected',model:DEX_MODEL,feeAccountingVersion:1},net={key:'base-sepolia',chainId:84532,shared:old};
 assert.equal(fixture(net,saved,1).deployment.factory,'corrected');
 assert.equal(fixture(net,{...saved,feeAccountingVersion:undefined},0).deployment.factory,'old');
 assert.equal(fixture({...net,shared:{factory:'team-corrected',model:DEX_MODEL,feeAccountingVersion:1}},saved,1).deployment.factory,'team-corrected');
 assert.equal(fixture({...net,key:'base',chainId:8453},saved,0).deployment.factory,'old');
});
test('revision inspection distinguishes an absent getter from an RPC failure',async()=>{
 const method=source.slice(source.indexOf('  async checkFeeAccounting('),source.indexOf('  async verifyFactory('));
 let result=0,failure=null;
 const context={DEX_MODEL,Contract:class{async FEE_ACCOUNTING_VERSION(){if(failure)throw failure;return result;}}};
 vm.runInNewContext('class Wallet{'+method+'}; globalThis.Wallet=Wallet;',context);const w=new context.Wallet();Object.assign(w,{net:{key:'base-sepolia'},model:DEX_MODEL,provider:{}});
 failure={code:'CALL_EXCEPTION',data:'0x'};assert.equal(await w.checkFeeAccounting({target:'old'}),0);
 failure=new Error('RPC unavailable');await assert.rejects(w.checkFeeAccounting({target:'old'}),/RPC unavailable/);assert.equal(w.feeAccountingVersion,undefined);
 failure=null;result=1;assert.equal(await w.checkFeeAccounting({target:'new'}),1);
});
