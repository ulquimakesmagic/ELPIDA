import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRetention} from '../apps/api/backup-retention.mjs';
import {BackupStore} from '../apps/api/backup-store.mjs';
test('retention review protects newest snapshots, incomplete sets, future dates and foreign objects',()=>{
 const now=2000000000000,objects=[];const add=(age,manifest=true)=>{const id=`ops-${now-age*86400000}-11111111-1111-1111-1111-111111111111`;objects.push({key:`elpida-backups/${id}/data.enc`,size:10});if(manifest)objects.push({key:`elpida-backups/${id}/MANIFEST.json.enc`,size:20});return id;};
 const oldest=add(60);for(let i=0;i<7;i++)add(40+i);const partial=add(80,false),future=add(-1);objects.push({key:'elpida-backups/unrelated/file',size:1});
 const result=reviewRetention(objects,{now});assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].id,oldest);assert.equal(result.unrecognizedObjects,1);assert.equal(result.retained.find(g=>g.id===partial).reason,'incomplete-needs-review');assert.equal(result.retained.find(g=>g.id===future).reason,'future-dated-needs-review');assert.equal(result.mode,'review-only');assert.throws(()=>reviewRetention(objects,{now,keep:0}));
});
test('inventory follows pagination and fails on repeated tokens rather than silently truncating',async()=>{
 const commands=[];let repeated=false;
 const client={send:async c=>{commands.push(c);assert.equal(c.constructor.name,'ListObjectsV2Command');assert.equal(c.input.Prefix,'elpida-backups/');return c.input.ContinuationToken?{Contents:[{Key:'elpida-backups/b',Size:2}],IsTruncated:repeated,NextContinuationToken:'next'}:{Contents:[{Key:'elpida-backups/a',Size:1}],IsTruncated:true,NextContinuationToken:'next'};}};
 const store=new BackupStore({endpoint:'https://s3.example.com',bucket:'elpida-backups',client});assert.equal((await store.inventory()).length,2);repeated=true;await assert.rejects(store.inventory(),/pagination/);assert.ok(commands.every(c=>c.constructor.name==='ListObjectsV2Command'));
});
