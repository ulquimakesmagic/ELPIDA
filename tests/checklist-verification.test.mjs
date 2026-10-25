// The checklist verifier turns "A2 ... 0x284c..." into a checked fact. These tests pin the parsing and the decision
// logic without touching the network: the RPC call is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChecklist,verifyHashes} from '../scripts/verify-checklist.mjs';

const HASH='0x'+'ab'.repeat(32);
const nets=[{key:'base-sepolia',chainId:84532,rpcUrl:'https://a'},{key:'bnb-testnet',chainId:97,rpcUrl:'https://b'}];
const noWait=async()=>{};

test('only full hashes are checkable; truncated ones are listed, addresses are ignored',()=>{
  const text=[
    '| A2 | graduation `0x'+'11'.repeat(32)+'` |',
    '| A3 | pool buy `0x6bf48beae9` and a truncated `0x27a4\u20260e4b` |',
    '| A4 | token 0x'+'22'.repeat(20)+' and curve 0xd306e88c1ab4ac0d89dcc341559be6dd1a5ecbef |',
  ].join('\n');
  const {hashes,truncated}=parseChecklist(text);
  assert.equal(hashes.length,1,'one full hash');
  assert.equal(hashes[0].hash,'0x'+'11'.repeat(32));
  assert.equal(hashes[0].label,'A2');
  assert.equal(truncated.length,1);
  assert.equal(truncated[0].hash,'0x27a4\u20260e4b');
});

test('the chain that answers is recorded, with its block and status',async()=>{
  const call=async url=>url==='https://b'?{blockNumber:'0x2a',status:'0x1',from:'0xf',to:'0xt',gasUsed:'0x5208'}:null;
  const [result]=await verifyHashes({hashes:[{hash:HASH,label:'A2',line:1}],networks:nets,call,wait:noWait});
  assert.equal(result.verified,true);
  assert.equal(result.chain,'bnb-testnet');
  assert.equal(result.chainId,97);
  assert.equal(result.block,42);
  assert.equal(result.gasUsed,21000);
});

test('a reverted transaction is not evidence, and an absent one says so',async()=>{
  const reverted=async()=>({blockNumber:'0x1',status:'0x0'});
  const [bad]=await verifyHashes({hashes:[{hash:HASH,label:'A5',line:2}],networks:[nets[0]],call:reverted,wait:noWait});
  assert.equal(bad.verified,false);
  assert.equal(bad.status,0);

  const missing=async()=>null;
  const [absent]=await verifyHashes({hashes:[{hash:HASH,label:'A3',line:3}],networks:nets,call:missing,wait:noWait});
  assert.equal(absent.verified,false);
  assert.match(absent.error,/not found/);
  assert.equal(absent.chainsTried,2,'both chains were tried');
});
