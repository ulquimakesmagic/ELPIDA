import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,AbiCoder} from 'ethers';
import {verifiedHolderSnapshot} from '../apps/api/holder-snapshot.mjs';
const token='0x0000000000000000000000000000000000000001',wallet='0x0000000000000000000000000000000000000002';
const iface=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const log=iface.encodeEventLog(iface.getEvent('Transfer'),['0x0000000000000000000000000000000000000000',wallet,100n]);
function rpc({holding=100n,supply=100n,hash='0xabc',logs=[log],head=100}={}){return {
 getNetwork:async()=>({chainId:31337n}),getBlockNumber:async()=>head,getBlock:async()=>({hash}),getLogs:async()=>logs,
 call:async tx=>AbiCoder.defaultAbiCoder().encode(['uint256'],[tx.data.startsWith('0x70a08231')?holding:supply])
};}
const options=providers=>({providers,chainId:31337,token,snapshotBlock:10,confirmations:20});
test('historical snapshot reconciles supply and independent balances',async()=>{
 const result=await verifiedHolderSnapshot(options([rpc(),rpc()]));assert.deepEqual(result.rows,[{address:wallet,holding:'100'}]);
 await assert.rejects(verifiedHolderSnapshot(options([rpc({logs:[]}),rpc()])),/Incomplete snapshot supply/);
 await assert.rejects(verifiedHolderSnapshot(options([rpc(),rpc({holding:99n,supply:99n})])),/disagreement/);
 await assert.rejects(verifiedHolderSnapshot(options([rpc(),rpc({hash:'0xdef'})])),/disagreement/);
 await assert.rejects(verifiedHolderSnapshot(options([rpc({head:11}),rpc()])),/not confirmed/);
});

test('snapshot rejects a reorg during historical reads, wrong chains and shared providers',async()=>{
 const changing=rpc();let reads=0;
 changing.getBlock=async()=>({hash:++reads===1?'0xabc':'0xdef'});
 await assert.rejects(verifiedHolderSnapshot(options([changing,rpc()])),/Snapshot reorg/);
 const wrong=rpc();wrong.getNetwork=async()=>({chainId:1n});
 await assert.rejects(verifiedHolderSnapshot(options([rpc(),wrong])),/Wrong snapshot chain/);
 const shared=rpc();
 await assert.rejects(verifiedHolderSnapshot(options([shared,shared])),/independent providers/);
});
