import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicIndexer } from '../apps/api/public-indexer.mjs';

test('public registry survives restart; details are never added after launch, and details saved before that rule still load',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'elpida-public-')),creator=Wallet.createRandom();
  const factory='0x'+'11'.repeat(20),token='0x'+'22'.repeat(20),curve='0x'+'33'.repeat(20);
  const options={dataDir:dir,networks:[{key:'test',chainId:84532,shared:{factory,block:1,model:'curve-dex-v9'},nativeCurrency:{symbol:'ETH'},explorer:'https://example.com'}],contracts:Object.fromEntries(['dexFactory','dexCurve','factory','curve','pool','token'].map(n=>[n,{abi:[]}])),providerFactory:()=>({destroy(){}}),metadataStore:{},log(){}};
  let service=new PublicIndexer(options);
  try{
    const e=service.entries.get('test');e.index.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(token,1,JSON.stringify({address:token,creator:creator.address,curve,metadataURI:'',name:'Public token'}));
    assert.equal(service.metadataMessage,undefined,'there is no signed after-launch metadata path');
    assert.equal(service.saveMetadata,undefined);
    // A token creator-signed on testnet before the rule keeps its details across restarts.
    writeFileSync(e.metadataPath,JSON.stringify({[token]:{description:'Public creator details'}}));
    await service.close();service=new PublicIndexer(options);
    assert.equal(service.listings('test')[0].metadata.description,'Public creator details');
    assert.equal(service.listings('test')[0].metadataStatus,'creator-signed');
    assert.equal(service.listings('test')[0].name,'Public token');
    assert.equal(service.status('unknown').enabled,false);
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});

test('approved pairs come only from the validated factory index',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(height INTEGER,idx INTEGER,data TEXT)');
 const factory='0x'+'11'.repeat(20),asset='0x'+'22'.repeat(20),insert=db.prepare('INSERT INTO events VALUES(?,?,?)');
 insert.run(1,0,JSON.stringify({kind:'factory',name:'QuoteApproved',address:factory,args:[asset,'1','adapter']}));
 insert.run(1,1,JSON.stringify({kind:'curve',name:'QuoteApproved',address:factory,args:['wrong']}));
 insert.run(1,2,JSON.stringify({kind:'factory',name:'QuoteApproved',address:asset,args:['wrong']}));
 const e={net:{shared:{factory},chainId:84532},validated:false,index:{db,status:()=>({indexedBlock:1})}},service=Object.create(PublicIndexer.prototype);service.entries=new Map([['test',e]]);
 assert.equal(service.quotes('test'),null);e.validated=true;assert.deepEqual(service.quotes('test'),{factory,chainId:84532,indexedBlock:1,assets:[asset]});assert.equal(service.quotes('missing'),null);db.close();
});

test('only successful validated index synchronization authorizes staged metadata retention',async()=>{
 const retained=[],uri='ipfs://'+'b'+'a'.repeat(40);
 const e={validated:true,net:{key:'test'},metadata:new Map(),index:{sync:async()=>{},tokens:()=>[{address:'token',metadataURI:uri}],status:()=>({indexedBlock:1})}};
 const service=Object.create(PublicIndexer.prototype);Object.assign(service,{entries:new Map([['test',e]]),metadataStore:{retainPublished:id=>retained.push(id),resolve:async()=>({description:'Confirmed metadata'})},log(){}});
 await service.tick();assert.deepEqual(retained,[uri]);assert.equal(e.metadata.get('token').description,'Confirmed metadata');
 await service.tick();assert.equal(retained.length,2,'retention is replayed even with cached metadata');
 e.index.sync=async()=>{throw new Error('Unverified chain state');};await service.tick();assert.equal(retained.length,2,'failed synchronization cannot grant retention');
});

test('a legacy team factory stays listed and tradable next to the current one',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'elpida-legacy-')),creator=Wallet.createRandom();
  const current='0x'+'aa'.repeat(20),old='0x'+'bb'.repeat(20),newToken='0x'+'01'.repeat(20),oldToken='0x'+'02'.repeat(20);
  const net={key:'test',chainId:84532,shared:{factory:current,block:10,model:'curve-dex-v10'},legacy:[{factory:old,block:1,model:'curve-dex-v9'},{factory:current,block:10,model:'curve-dex-v10'}],nativeCurrency:{symbol:'ETH'},explorer:'https://example.com'};
  let destroyed=0;
  const options={dataDir:dir,networks:[net],contracts:Object.fromEntries(['dexFactory','dexCurve','factory','curve','pool','token'].map(n=>[n,{abi:[]}])),providerFactory:()=>({destroy(){destroyed++;}}),metadataStore:{},log(){}};
  const service=new PublicIndexer(options);
  try{
    assert.equal(service.all('test').length,2,'the current factory is never duplicated as legacy');
    const [now,legacy]=service.all('test');
    assert.equal(legacy.deployment.factory,old);assert.equal(legacy.legacy,true);assert.equal(now.legacy,false);
    now.index.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(newToken,20,JSON.stringify({address:newToken,creator:creator.address,curve:'0x'+'03'.repeat(20),metadataURI:'',name:'New'}));
    legacy.index.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(oldToken,5,JSON.stringify({address:oldToken,creator:creator.address,curve:'0x'+'04'.repeat(20),metadataURI:'',name:'Old'}));
    const list=service.listings('test',e=>({source:e.deployment.factory}));
    assert.deepEqual(list.map(t=>[t.name,t.factory,t.deploymentModel,t.legacyDeployment,t.source]),[['New',current,'curve-dex-v10',false,current],['Old',old,'curve-dex-v9',true,old]]);
    assert.equal(service.entryFor('test',oldToken.toUpperCase().replace('0X','0x')),legacy);
    assert.equal(service.entryFor('test',newToken),now);
    assert.equal(service.entryFor('test','0x'+'09'.repeat(20)),null);
    assert.equal(service.detail('test',oldToken).name,'Old');
    // Trade rows from both deployments merge in time order.
    for(const [e,ts,id] of [[now,30,'c'],[legacy,10,'a'],[legacy,20,'b']])e.index.db.prepare('INSERT INTO trades(tx,idx,address,height,timestamp,data) VALUES(?,?,?,?,?,?)').run(id,0,'t',1,ts,JSON.stringify({id}));
    assert.deepEqual([...service.tradeRows('test')].map(r=>JSON.parse(r.data).id),['a','b','c']);
    // The "Last sale" strip: newest first across both deployments, public fields only, unknown tokens skipped.
    for(const [e,ts,token,side] of [[now,40,newToken,'buy'],[legacy,35,oldToken,'sell'],[legacy,50,'0x'+'09'.repeat(20),'buy']])e.index.db.prepare('INSERT INTO trades(tx,idx,address,height,timestamp,data) VALUES(?,?,?,?,?,?)').run('r'+ts,0,token,2,ts,JSON.stringify({token,side,account:'0xsecret',quoteAmount:'5'}));
    const recent=service.recentTrades(5);
    assert.deepEqual(recent.map(r=>[r.name,r.side,r.timestamp,r.network]),[['New','buy',40,'test'],['Old','sell',35,'test']]);
    assert.deepEqual(Object.keys(recent[0]).sort(),['address','height','image','index','name','network','side','symbol','timestamp','tx']);
    // Pair discovery stays on the current factory only.
    assert.equal(service.quotes('test'),null,'unvalidated current factory');
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
  assert.equal(destroyed,1,'one shared provider per network is closed once');
});

test('a public RPC that keeps failing on the server is replaced by the next one; status shows only a code and a host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elpida-failover-')), made = [], logs = [];
  const net = { key: 'test', chainId: 11155111, rpcUrl: 'https://main.example/rpc', rpcFallbacks: ['https://backup.example/v1/secret-key'], shared: { factory: '0x' + 'aa'.repeat(20), block: 1, model: 'curve-dex-v10' }, nativeCurrency: { symbol: 'ETH' }, explorer: 'https://example.com' };
  const options = { dataDir: dir, networks: [net], contracts: Object.fromEntries(['dexFactory', 'dexCurve', 'factory', 'curve', 'pool', 'token'].map(n => [n, { abi: [] }])), providerFactory: url => { const p = { url, destroyed: false, destroy() { this.destroyed = true; } }; made.push(p); return p; }, metadataStore: {}, log: line => logs.push(JSON.parse(line)) };
  const service = new PublicIndexer(options);
  try {
    const [e] = service.all('test');
    e.validated = true;
    e.index.sync = async () => { throw Object.assign(new Error('403 Forbidden from https://main.example/rpc'), { code: 'SERVER_ERROR' }); };
    for (let i = 0; i < PublicIndexer.FAILOVER_AFTER - 1; i++) await service.tick();
    assert.equal(e.provider.url, 'https://main.example/rpc', 'a short outage does not switch');
    let status = service.status('test');
    assert.equal(status.errorCode, 'SERVER_ERROR'); assert.equal(status.rpc, 'main.example');
    assert.ok(!JSON.stringify(status).includes('403 Forbidden'), 'never the raw message');
    await service.tick();
    assert.equal(e.provider.url, 'https://backup.example/v1/secret-key', 'moved to the next RPC');
    assert.equal(e.index.provider, e.provider, 'the index reads through the new RPC');
    assert.equal(e.validated, false, 'the deployment is re-validated on the new RPC');
    assert.ok(made[0].destroyed, 'the old provider is closed');
    const failover = logs.find(l => l.event === 'public_indexer_rpc_failover');
    assert.deepEqual([failover.from, failover.to], ['main.example', 'backup.example']);
    status = service.status('test');
    assert.equal(status.rpc, 'backup.example'); assert.ok(!JSON.stringify(status).includes('secret-key'), 'paths with keys never shown');
    e.validated = true; e.index.sync = async () => {}; await service.tick();
    status = service.status('test'); assert.equal(status.error, null); assert.equal(status.errorCode, null);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
