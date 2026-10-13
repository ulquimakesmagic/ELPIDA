import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore,rawCid} from '../apps/api/metadata-store.mjs';
import {MAX_IMAGE_BYTES} from '../apps/web/metadata.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const body={name:'Shared Garden',symbol:'GARDEN',description:'A shared community 🌱',image:png,website:'https://example.com'};
test('a 5 MB logo is published and resolved without embedding it in the metadata document',async()=>{
 const bytes=Buffer.alloc(MAX_IMAGE_BYTES);Buffer.from(png.split(',')[1],'base64').copy(bytes);
 const store=new MetadataStore({jwt:null});
 const result=await store.publish({...body,image:'data:image/png;base64,'+bytes.toString('base64')});
 const image=store.get(result.metadata.image.split('/').at(-1));
 assert.equal(Buffer.from(image.data,'base64').length,MAX_IMAGE_BYTES);
 assert.equal(image.type,'image/png');
 assert.ok(Buffer.from(store.get(result.uri.slice(7)).data,'base64').length<20000);
});
test('content addressed logo and metadata survive a new reader with no creator browser state',async t=>{
 const path=mkdtempSync(join(tmpdir(),'elpida-metadata-'));t.after(()=>rmSync(path,{recursive:true}));
 const writer=new MetadataStore({path,jwt:null}),published=await writer.publish(body);
 assert.equal(published.public,false);assert.match(published.uri,/^ipfs:\/\/bafkre/);
 const reader=new MetadataStore({path,jwt:null,fetcher:()=>{throw new Error('Unexpected network access');}});
 const details=await reader.resolve(published.uri);assert.equal(details.description,body.description);assert.match(details.image,/^\/api\/content\//);
 assert.equal(reader.get(details.image.split('/').at(-1)).type,'image/png');
 const duplicate=await writer.publish(body);assert.equal(duplicate.uri,published.uri);
 const changed=await writer.publish({...body,description:'Changed'});assert.notEqual(changed.uri,published.uri);assert.equal((await reader.resolve(published.uri)).description,body.description);
});
test('Pinata uploads are public, use server credentials and pin logo before metadata',async()=>{
 const uploads=[];const store=new MetadataStore({jwt:'server-secret',fetcher:async(url,options)=>{
   assert.equal(url,'https://uploads.pinata.cloud/v3/files');assert.equal(options.headers.Authorization,'Bearer server-secret');assert.equal(options.body.get('network'),'public');
   const file=options.body.get('file'),bytes=Buffer.from(await file.arrayBuffer());uploads.push(JSON.parse(file.type==='application/json'?bytes.toString():'null'));
   return Response.json({data:{cid:rawCid(bytes)}});
 }});
 const published=await store.publish(body,true);assert.equal(published.public,true);assert.equal(uploads.length,2);assert.match(uploads[1].image,/^ipfs:\/\//);assert.ok(!JSON.stringify(store.status()).includes('server-secret'));
});
test('publishing fails closed when key is absent or upload fails, and resolver refuses arbitrary fetch URLs',async()=>{
 const store=new MetadataStore({jwt:null,fetcher:()=>{throw new Error('Unexpected network access');}});
 await assert.rejects(store.publish(body,true),/not configured/);
 for(const uri of ['http://127.0.0.1/secret','ipfs://../../secret','ipfs://x?url=http://localhost'])await assert.rejects(store.resolve(uri));
 const failed=new MetadataStore({jwt:'server-secret',fetcher:async()=>new Response('',{status:401})});await assert.rejects(failed.publish(body,true),/provider rejected/);
});
test('untrusted remote metadata is size bounded, validated and checked against raw CIDs',async()=>{
 const document=JSON.stringify({schema:'elpida-token-v1',...body,image:'https://example.com/image.png'}),cid=rawCid(Buffer.from(document));
 const reader=new MetadataStore({jwt:null,fetcher:async()=>new Response(document)});assert.equal((await reader.resolve('ipfs://'+cid)).description,body.description);
 const corrupt=new MetadataStore({jwt:null,fetcher:async()=>new Response(document+' ')});await assert.rejects(corrupt.resolve('ipfs://'+cid),/integrity/);
 const huge=new MetadataStore({jwt:null,fetcher:async()=>new Response('x'.repeat(20001))});await assert.rejects(huge.resolve('ipfs://'+cid),/too large/);
});

test('pending quotas survive restart and verified publication retains the document and logo',async t=>{
 const path=mkdtempSync(join(tmpdir(),'elpida-retention-'));t.after(()=>rmSync(path,{recursive:true}));
 let now=1000;const opts={path,jwt:null,chainBound:true,now:()=>now,pendingAge:100,maxBytes:100000,maxPendingBytes:30000};
 const writer=new MetadataStore(opts),result=await writer.publish(body);
 const before=writer.status().storage;assert.ok(before.pendingBytes>0);
 const reader=new MetadataStore(opts);assert.equal(reader.status().storage.pendingBytes,before.pendingBytes);
 now=2000;assert.equal(reader.status().storage.expiredPendingBytes,before.pendingBytes);
 assert.equal((await reader.resolve(result.uri)).description,body.description,'old pending content is never deleted solely by age');
 await reader.publish(body);assert.equal(reader.status().storage.pendingBytes,before.pendingBytes,'simulation or duplicate uploads cannot grant chain retention');
 reader.retainPublished(result.uri);assert.equal(reader.status().storage.pendingBytes,0);
 const restarted=new MetadataStore(opts);assert.equal(restarted.status().storage.pendingBytes,0);assert.equal((await restarted.resolve(result.uri)).description,body.description);
});

test('quota rejects before provider billing, exact content deduplicates and published data stays available',async()=>{
 let uploads=0;const store=new MetadataStore({jwt:'test',maxBytes:20000,maxPendingBytes:20000,fetcher:async()=>{uploads++;throw new Error('unexpected upload');}});
 await assert.rejects(store.publish(body,true,{provisional:true}),/storage limit/);assert.equal(uploads,0);
 const limited=new MetadataStore({jwt:null,maxBytes:200,maxPendingBytes:100,chainBound:true});
 const bytes=Buffer.from('small'),cid=rawCid(bytes);limited.put(cid,bytes,'text/plain');const used=limited.status().storage.bytes;
 limited.put(cid,bytes,'text/plain');assert.equal(limited.status().storage.bytes,used);
 assert.throws(()=>limited.put(rawCid(Buffer.alloc(100)),Buffer.alloc(100),'text/plain'),/storage limit/);
 limited.retainPublished('ipfs://'+cid);assert.equal(limited.status().storage.pendingBytes,0);assert.equal(limited.get(cid).data,bytes.toString('base64'));
});
