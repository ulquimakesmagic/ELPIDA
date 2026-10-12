import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {discoveryTokens,indexedChange} from '../apps/web/discovery.mjs';
const now=2000000000,ref={status:'fresh',usd:2000,updatedAt:now};
const t=(address,price,extra={})=>({address,network:'base',name:address,symbol:address,spotPrice:price,supply:1e9,usdReference:ref,...extra});
test('discovery compares USD caps, puts missing/stale rates last and orders ties deterministically',()=>{
 const a=t('a',2,{usdReference:{...ref,usd:1}}),b=t('b',1),c=t('c',100,{usdReference:null}),d=t('d',100,{usdReference:{...ref,updatedAt:now-181}});
 assert.deepEqual(discoveryTokens([d,c,a,b],{},now).map(t=>t.address),['b','a','c','d']);
 assert.deepEqual(discoveryTokens([a,b],{category:'new'},now).map(t=>t.address),['a','b']);
});
test('migration and graduation filters use confirmed lifecycle states',()=>{
 const all=[t('curve',1),t('pending',1,{complete:true}),t('dex',1,{complete:true,graduated:true})];
 assert.deepEqual(discoveryTokens(all,{category:'migrating'},now).map(t=>t.address),['pending']);assert.deepEqual(discoveryTokens(all,{category:'graduated'},now).map(t=>t.address),['dex']);
});
test('24h change needs both recent execution and a sufficiently close historical comparison',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE trades(address TEXT,timestamp INTEGER,data TEXT)');const insert=db.prepare('INSERT INTO trades VALUES(?,?,?)');
 assert.equal(indexedChange(db,{address:'a'},now),null);
 for(const [timestamp,priceQuote] of [[now-86400,2],[now-20,3]])insert.run('a',timestamp,JSON.stringify({timestamp,priceQuote}));
 assert.equal(indexedChange(db,{address:'a'},now).percent,50);assert.equal(indexedChange(db,{address:'a'},now+4000),null);db.close();
});
