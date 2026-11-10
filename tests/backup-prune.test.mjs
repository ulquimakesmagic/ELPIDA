// Backups that do not grow forever (Malik, 10 November: 30 daily full copies had filled 27 GB of the backup bucket).
// After each verified snapshot the runner deletes the sets its retention policy no longer keeps, and scheduled
// snapshots leave out the chain indexes, which rebuild from the chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {backupKey} from '../apps/api/backup-encryption.mjs';
import {BackupRunner,configuredBackup} from '../apps/api/backup-runner.mjs';
import {retentionPlan} from '../apps/api/backup-retention.mjs';
import {BackupStore} from '../apps/api/backup-store.mjs';
import {MetadataStore} from '../apps/api/metadata-store.mjs';

const DAY=86400000,key=backupKey('ab'.repeat(32));
const idAt=(t,n=1)=>`ops-${t}-${String(n).padStart(8,'0')}-1111-1111-1111-111111111111`;
const set=(objects,t,{complete=true,n=1}={})=>{const id=idAt(t,n);objects.push({key:`elpida-backups/${id}/token-metadata.json.enc`,size:100});if(complete)objects.push({key:`elpida-backups/${id}/MANIFEST.json.enc`,size:10});return id;};

test('retention keeps 7 daily, 4 weekly and 3 monthly snapshots, drops stale incomplete sets, ignores everything else', () => {
  const now=Date.UTC(2026,10,10,12),objects=[],ids=[];
  for(let d=0;d<90;d++)ids.push(set(objects,now-d*DAY));
  const partialOld=set(objects,now-20*DAY,{complete:false,n:2}),partialNew=set(objects,now-1*DAY,{complete:false,n:3}),future=set(objects,now+DAY,{n:4});
  objects.push({key:'elpida-backups/unrelated/file',size:5},{key:'other/thing',size:5});
  const plan=retentionPlan(objects,{now}),kept=new Set(plan.keep),dropped=new Set(plan.delete.map(g=>g.id));
  for(let d=0;d<7;d++)assert.ok(kept.has(ids[d]),`day ${d} kept`);
  assert.ok(kept.size<=7+4+3+3,'at most the policy plus the sets it never touches');
  assert.ok(dropped.has(partialOld),'an old incomplete set cannot be restored, so it goes');
  assert.ok(kept.has(partialNew)&&kept.has(future),'a fresh incomplete set (maybe still uploading) and a future-dated one stay');
  assert.ok(dropped.has(ids[89]),'three months back is beyond the policy');
  // Each kept older snapshot is the newest of its week or month.
  const monthsKept=new Set(ids.filter(i=>kept.has(i)).map(i=>new Date(Number(i.slice(4,17))).getUTCMonth()));
  assert.equal(monthsKept.size,3);
  assert.ok(plan.delete.every(g=>g.keys.every(k=>k.startsWith(`elpida-backups/${g.id}/`))));
  // Never fewer than 2, even with daily 0.
  assert.equal(retentionPlan(objects,{now,daily:0,weekly:0,monthly:0}).keep.filter(i=>ids.includes(i)).length,2);
  assert.throws(()=>retentionPlan(objects,{now,daily:-1}),/Invalid retention/);
});

test('the store deletes only backup snapshot objects, in batches, and falls back to single deletes', async () => {
  const sent=[];let batch=true;
  const client={send:async c=>{sent.push(c);if(c.constructor.name==='DeleteObjectsCommand'&&!batch)throw new Error('NotImplemented');return {};}};
  const store=new BackupStore({endpoint:'https://s3.example.com',bucket:'elpida-backups',client});
  const keys=Array.from({length:1500},(_,i)=>`elpida-backups/${idAt(1790000000000+i)}/x.enc`);
  await store.deleteKeys(keys);
  assert.deepEqual(sent.map(c=>c.input.Delete.Objects.length),[1000,500]);
  sent.length=0;batch=false;await store.deleteKeys(keys.slice(0,3));
  assert.deepEqual(sent.map(c=>c.constructor.name),['DeleteObjectsCommand','DeleteObjectCommand','DeleteObjectCommand','DeleteObjectCommand']);
  await assert.rejects(store.deleteKeys(['elpida-backups/unrelated/file']),/outside a backup snapshot/);
  await assert.rejects(store.deleteKeys(['other/thing']),/outside a backup snapshot/);
});

test('after a verified backup the runner prunes old sets, leaves chain indexes out and keeps the V2 keeper state', async t => {
  const dir=mkdtempSync(join(tmpdir(),'elpida-prune-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const dataDir=join(dir,'data');mkdirSync(dataDir);
  await new MetadataStore({path:join(dataDir,'ipfs-content'),jwt:null}).publish({name:'Keep',symbol:'KEEP',description:'Kept in every backup'});
  for(const name of ['public-84532-0x'+'11'.repeat(20)+'.sqlite','v2-keeper.sqlite']){const db=new DatabaseSync(join(dataDir,name));db.exec('CREATE TABLE t(x TEXT); INSERT INTO t VALUES (\'v\');');db.close();}
  writeFileSync(join(dataDir,'token-metadata.json'),'{}');
  const now=Date.UTC(2026,10,10,12),objects=new Map(),deleted=[];
  const store={uploadVerified:async(k,f)=>{objects.set(k,readFileSync(f));},download:async(k,f)=>{writeFileSync(f,objects.get(k),{flag:'wx'});},
    inventory:async()=>[...objects].map(([k,v])=>({key:k,size:v.length})),deleteKeys:async keys=>{for(const k of keys){deleted.push(k);objects.delete(k);}},close(){}};
  // Thirty older daily snapshots already in the bucket, as on elpida.fun before this change.
  const old=[];for(let d=1;d<=30;d++)set(old,now-d*DAY);
  for(const o of old)objects.set(o.key,Buffer.alloc(o.size));
  const logs=[],r=new BackupRunner({dataDir,statePath:join(dataDir,'ops-backup-state.json'),workDir:join(dir,'work'),store,key,now:()=>now,log:v=>logs.push(JSON.parse(v))});
  await r.run();
  assert.equal(r.state.lastError,null);
  const id=r.state.lastRemoteId,paths=[...objects.keys()].filter(k=>k.startsWith(`elpida-backups/${id}/`)).map(k=>k.slice(`elpida-backups/${id}/`.length));
  assert.ok(paths.includes('v2-keeper.sqlite.enc'),'the keeper state (published payout lists) is backed up');
  assert.ok(!paths.some(p=>p.startsWith('public-84532-')),'the chain index is left out');
  assert.ok(paths.some(p=>p.startsWith('ipfs-content/')));
  const sets=new Set([...objects.keys()].map(k=>k.split('/')[1]));
  assert.ok(sets.has(id));
  assert.ok(sets.size<=7+4+3,`old sets pruned (${sets.size} left)`);
  assert.ok(deleted.length>=15&&deleted.every(k=>!k.includes(id)),'never the snapshot just made');
  const ev=logs.find(l=>l.event==='backup_pruned');
  assert.ok(ev&&ev.snapshots===deleted.length/2);
  assert.equal(r.status().retention.prunedSnapshots,ev.snapshots);
  // A failed inventory is reported and never fails the backup itself.
  store.inventory=async()=>{throw Object.assign(new Error('down'),{code:'TimeoutError'});};
  await r.prune(store,id);
  assert.equal(r.status().retention.lastError,'TimeoutError');
  assert.equal(r.state.lastError,null);
});

test('retention and chain indexes are configurable; retention can be switched off', () => {
  const base={ELPIDA_BACKUP_ENABLED:'true',ELPIDA_BACKUP_S3_ENDPOINT:'https://s3.example.com',ELPIDA_BACKUP_S3_BUCKET:'elpida-backups',ELPIDA_BACKUP_S3_ACCESS_KEY_ID:'id',ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY:'secret',ELPIDA_BACKUP_ENCRYPTION_KEY:'ab'.repeat(32)};
  const make=env=>configuredBackup({env:{...base,...env},dataDir:'/tmp/none',statePath:null,workDir:null,log:()=>{}});
  assert.deepEqual(make({}).retention,{daily:7,weekly:4,monthly:3});
  assert.equal(make({}).chainIndexes,false);
  assert.deepEqual(make({ELPIDA_BACKUP_KEEP_DAILY:'3',ELPIDA_BACKUP_KEEP_WEEKLY:'0'}).retention,{daily:3,weekly:0,monthly:3});
  assert.equal(make({ELPIDA_BACKUP_RETENTION:'off'}).retention,null);
  assert.equal(make({ELPIDA_BACKUP_CHAIN_INDEXES:'true'}).chainIndexes,true);
  assert.equal(make({ELPIDA_BACKUP_KEEP_DAILY:'-2'}).state.lastError,'BACKUP_CONFIGURATION');
});
