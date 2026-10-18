import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {createElpidaSolana,parseAmount} from '../packages/solana/client.mjs';
test('zero is permitted only for the optional purchase parser and Solana probes distinguish old programs from RPC failure',async()=>{
 assert.equal(parseAmount('0',6,true),0n);assert.throws(()=>parseAmount('0',6),/greater/);assert.throws(()=>parseAmount('-1',6,true));
 const payer=web3.Keypair.generate().publicKey,client=createElpidaSolana(web3,payer);
 let result={err:null};const connection={getLatestBlockhash:async()=>({blockhash:web3.Keypair.generate().publicKey.toBase58()}),simulateTransaction:async tx=>{
  assert.deepEqual([...tx.instructions[0].data],[...createHash('sha256').update('global:optional_buy_version').digest().subarray(0,8)]);return {value:result};
 }};
 assert.equal(await client.supportsOptionalBuy(connection,payer),true);
 result={err:{InstructionError:[0,{Custom:101}]}};assert.equal(await client.supportsOptionalBuy(connection,payer),false);
 result={err:'AccountNotFound'};await assert.rejects(client.supportsOptionalBuy(connection,payer),/Could not check/);
});
