import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../apps/api/curve-runtime.mjs';
import {EvmIndexer} from '../packages/indexer/evm-indexer.mjs';
import {evmConfirmations} from '../apps/api/public-indexer.mjs';

test('durable indexer captures initial buy, replay, restart, reorg and migration into pool',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-index-')),path=join(dir,'index.sqlite');
 const runtime=await createRuntime({seed:false,indexerPath:path});
 t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});
 const launched=await runtime.transact('launch',{name:'Indexed Garden',symbol:'INDEX',pair:'native',firstBuy:'0.01'});
 const token=launched.token.toLowerCase(),i=runtime.indexer;
 assert.equal(i.trades(token).length,1,'creation block first buy indexed');
 assert.equal(i.trades(token)[0].quoteAmount,'0.01');
 assert.equal(i.snapshot(token).priceUsd,null,'no invented ETH dollar price');
 const saved=i.snapshot(token);await i.sync();assert.deepEqual(i.snapshot(token),saved);assert.equal(i.trades(token).length,1);
 const replay=new EvmIndexer({provider:runtime.provider,factory:runtime.config.local.factory,contracts:runtime.config.contracts,fromBlock:i.fromBlock});
 await replay.sync();assert.deepEqual(replay.snapshot(token),saved);assert.deepEqual(replay.trades(token),i.trades(token));await replay.close();
 const batched=new EvmIndexer({provider:runtime.provider,factory:runtime.config.local.factory,contracts:runtime.config.contracts,fromBlock:i.fromBlock,batchSize:100});
 await batched.sync();assert.deepEqual(batched.trades(token),i.trades(token));assert.equal(batched.holders(token)[0].address,launched.creator?.toLowerCase()??runtime.config.accounts[0].address.toLowerCase());
 assert.ok(Number(batched.holders(token)[0].balance)>0);await batched.close();
 const reopened=new EvmIndexer({provider:runtime.provider,factory:runtime.config.local.factory,contracts:runtime.config.contracts,path,fromBlock:i.fromBlock});
 assert.deepEqual(reopened.snapshot(token),saved);await reopened.close();
 const snap=await runtime.provider.send('evm_snapshot',[]);
 await runtime.transact('buy',{token,amount:'0.02',account:'1'});assert.equal(i.trades(token).length,2);
 assert.equal(await runtime.provider.send('evm_revert',[snap]),true);await i.sync();
 assert.equal(i.trades(token).length,1,'orphan trade removed');assert.deepEqual(i.snapshot(token),saved);
 const completion=i.snapshot(token).remainingBuy;
 await runtime.transact('buy',{token,amount:completion,account:'0'});
 const end=i.snapshot(token),price=Number(end.spotPrice);assert.equal(end.complete,true);
 await runtime.transact('graduate',{token});const graduated=i.snapshot(token);
 assert.equal(graduated.graduated,true);assert.ok(Math.abs(Number(graduated.spotPrice)/price-1)<1e-9);
 assert.ok(Number(graduated.deadSupply)<1,'rounding dust only');
 await runtime.transact('sell',{token,amount:'1000000',account:'0'});
 assert.equal(i.trades(token)[0].venue,'pool');assert.equal(i.trades(token)[0].side,'sell');
 assert.ok(i.candles(token).length>0);assert.equal(i.candles(token).reduce((n,c)=>n+c.trades,0),3);
 assert.equal(i.status().lag,0);
 const rangeReplay=new EvmIndexer({provider:runtime.provider,factory:runtime.config.local.factory,contracts:runtime.config.contracts,fromBlock:i.fromBlock,batchSize:100});
 await rangeReplay.sync();assert.deepEqual(rangeReplay.trades(token),i.trades(token),'range backfill discovers pools and their later trades');assert.deepEqual(rangeReplay.snapshot(token),i.snapshot(token));await rangeReplay.close();
});

test('public EVM indexers read the newest block, and a replaced head block takes its trades with it', async t => {
 // The setting: newest block by default, raised only by an explicit whole number (capped at 64).
 for (const [value, depth] of [[undefined, 0], ['', 0], ['0', 0], ['3', 3], ['500', 64], ['-1', 0], ['1.5', 0], ['abc', 0]]) assert.equal(evmConfirmations(value), depth, String(value));
 // The batched mode the public indexers use, at depth 0: the head block's trade shows on the next sync and is
 // removed when that block is replaced.
 const dir = mkdtempSync(join(tmpdir(), 'elpida-head-')), runtime = await createRuntime({ seed: false, indexerPath: join(dir, 'local.sqlite') });
 t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
 const token = (await runtime.transact('launch', { name: 'Head Block', symbol: 'HEAD', pair: 'native', firstBuy: '0.01' })).token.toLowerCase();
 const head = new EvmIndexer({ provider: runtime.provider, factory: runtime.config.local.factory, contracts: runtime.config.contracts, fromBlock: runtime.indexer.fromBlock, batchSize: 100, confirmations: evmConfirmations('0') });
 t.after(() => head.close());
 await head.sync(); assert.equal(head.trades(token).length, 1);
 const snap = await runtime.provider.send('evm_snapshot', []);
 await runtime.transact('buy', { token, amount: '0.02', account: '1' });
 await head.sync(); assert.equal(head.trades(token).length, 2, 'the trade in the newest block is indexed straight away');
 assert.equal(head.status().lag, 0);
 await runtime.provider.send('evm_revert', [snap]);
 await runtime.transact('buy', { token, amount: '0.03', account: '0' });
 await head.sync();
 assert.deepEqual(head.trades(token).map(r => r.quoteAmount).sort(), ['0.01', '0.03'], 'the replaced block\'s trade is gone and the new one is in');
});
