import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicIndexer } from '../apps/api/public-indexer.mjs';

test('public registry survives restart and accepts metadata only from the indexed creator',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'elpida-public-')),creator=Wallet.createRandom(),other=Wallet.createRandom();
  const factory='0x'+'11'.repeat(20),token='0x'+'22'.repeat(20),curve='0x'+'33'.repeat(20);
  const options={dataDir:dir,networks:[{key:'test',chainId:84532,shared:{factory,block:1,model:'curve-dex-v9'},nativeCurrency:{symbol:'ETH'},explorer:'https://example.com'}],contracts:Object.fromEntries(['dexFactory','dexCurve','factory','curve','pool','token'].map(n=>[n,{abi:[]}])),providerFactory:()=>({destroy(){}}),metadataStore:{},log(){}};
  let service=new PublicIndexer(options);
  try{
    const e=service.entries.get('test');e.index.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(token,1,JSON.stringify({address:token,creator:creator.address,curve,metadataURI:'',name:'Public token'}));
    const body={network:'test',token,expires:Math.floor(Date.now()/1000)+200,metadata:{description:'Public creator details'}};
    const {message}=service.metadataMessage(body);
    assert.throws(()=>service.saveMetadata({...body,signature:other.signingKey.sign('0x'+'00'.repeat(32)).serialized}));
    assert.throws(()=>service.saveMetadata({...body,signature:'bad'}));
    await assert.rejects(async()=>service.saveMetadata({...body,signature:await other.signMessage(message)}),/creator/);
    service.saveMetadata({...body,signature:await creator.signMessage(message)});
    assert.equal(service.listings('test')[0].metadataStatus,'creator-signed');
    assert.throws(()=>service.metadataMessage({...body,expires:1}),/expired/);
    await service.close();service=new PublicIndexer(options);
    assert.equal(service.listings('test')[0].metadata.description,'Public creator details');
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
