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
