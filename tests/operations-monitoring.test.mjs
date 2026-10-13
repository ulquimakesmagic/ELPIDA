import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {backupKey,encryptBackupFile,decryptBackupFile} from '../apps/api/backup-encryption.mjs';
import {BackupRunner,configuredBackup} from '../apps/api/backup-runner.mjs';
import {restoreOffsite} from '../apps/api/offsite-restore.mjs';
import {MetadataStore} from '../apps/api/metadata-store.mjs';
import {evaluateOperations,OperationsMonitor} from '../apps/api/operations-health.mjs';
import {BackupStore} from '../apps/api/backup-store.mjs';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
const key=backupKey('ab'.repeat(32));
test('encrypted off-site backup restores metadata; scheduler survives restart and failures never claim success',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-ops-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const dataDir=join(dir,'data');mkdirSync(dataDir);
 const m=new MetadataStore({path:join(dataDir,'ipfs-content'),jwt:null}),p=await m.publish({name:'Recovery',symbol:'REC',description:'Recoverable metadata'}),objects=new Map();let now=2000000000000;
 const store={uploadVerified:async(k,f)=>{objects.set(k,readFileSync(f));},download:async(k,f)=>{if(!objects.has(k))throw new Error('Missing remote object');writeFileSync(f,objects.get(k),{flag:'wx'});},close(){}};
 const opts={dataDir,statePath:join(dataDir,'ops-backup-state.json'),workDir:join(dir,'work'),store,key,now:()=>now,log(){}};
 let r=new BackupRunner(opts);await r.tick();assert.equal(r.status().lastError,null);assert.ok(r.status().lastSuccess);const id=r.state.lastRemoteId;assert.ok([...objects.keys()].at(-1).endsWith('MANIFEST.json.enc'));
 await restoreOffsite({store,key,snapshotId:id,destination:join(dir,'restored'),workRoot:join(dir,'restore-work')});assert.equal((await new MetadataStore({path:join(dir,'restored','ipfs-content'),jwt:null}).resolve(p.uri)).description,'Recoverable metadata');
 const count=objects.size;r=new BackupRunner(opts);await r.tick();assert.equal(objects.size,count,'restart cannot duplicate a daily backup');now+=86400001;store.uploadVerified=async()=>{throw new Error('Secret credential must never be logged');};await r.tick();assert.equal(r.status().lastError,'BACKUP_FAILED');assert.equal(r.status().lastSuccess,new Date(2000000000000).toISOString());
});
test('encryption authenticates object identity and rejects tampering and overwrite',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-crypto-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const src=join(dir,'source'),enc=join(dir,'cipher');writeFileSync(src,'private draft');await encryptBackupFile(src,enc,key,'object-a');await decryptBackupFile(enc,join(dir,'good'),key,'object-a');assert.equal(readFileSync(join(dir,'good'),'utf8'),'private draft');
 await assert.rejects(decryptBackupFile(enc,join(dir,'wrong'),key,'object-b'));assert.equal(existsSync(join(dir,'wrong')),false);const bytes=readFileSync(enc);bytes[20]^=1;writeFileSync(enc,bytes);await assert.rejects(decryptBackupFile(enc,join(dir,'bad'),key,'object-a'));assert.equal(existsSync(join(dir,'bad')),false);await assert.rejects(decryptBackupFile(enc,src,key,'object-a'));assert.equal(readFileSync(src,'utf8'),'private draft');
});
test('monitor separates warnings from liveness, detects outages and logs incident transitions only',()=>{
 const now=2000000000000,good={now,startedAt:now-300000,durable:true,storage:{bytes:1,maxBytes:100,pendingBytes:0,maxPendingBytes:100},networks:{base:{enabled:true,lastSuccess:new Date(now).toISOString(),lag:2}},prices:{base:{status:'fresh',usd:2000,updatedAt:now/1000,maxAge:180}},backup:{enabled:true,lastSuccess:new Date(now).toISOString(),intervalMs:86400000}};
 assert.equal(evaluateOperations(good).status,'ok');const bad={...good,backup:{...good.backup,lastError:'Error'},storage:{...good.storage,bytes:100},networks:{base:{enabled:true,error:'RPC unavailable'}},prices:{}};assert.equal(evaluateOperations(bad).status,'critical');
 let value=bad;const logs=[],monitor=new OperationsMonitor({read:()=>value,now:()=>now,log:v=>logs.push(JSON.parse(v))});monitor.tick();const count=logs.length;monitor.tick();assert.equal(logs.length,count);value=good;monitor.tick();assert.ok(logs.slice(count).every(l=>l.state==='resolved'));
 assert.equal(configuredBackup({env:{ELPIDA_BACKUP_ENABLED:'true'}}).status().lastError,'BACKUP_CONFIGURATION');assert.equal(configuredBackup({env:{}}).status().enabled,false);
});
test('S3 adapter verifies uploaded bytes by readback and rejects corruption or oversized downloads',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-store-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'sealed');writeFileSync(file,'encrypted fixture');let object,tamper=false;
 const client={send:async command=>{if(command.constructor.name==='PutObjectCommand'){const chunks=[];for await(const chunk of command.input.Body)chunks.push(chunk);object=Buffer.concat(chunks);assert.equal(command.input.ContentLength,object.length);return {};}const bytes=Buffer.from(object);if(tamper)bytes[0]^=1;return {Body:Readable.from([bytes]),ContentLength:bytes.length};}};
 const store=new BackupStore({endpoint:'https://s3.example.com',bucket:'elpida-backups',client});const hash=createHash('sha256').update(readFileSync(file)).digest('hex');await store.uploadVerified('object',file,hash);tamper=true;await assert.rejects(store.uploadVerified('object',file,hash),/integrity/);await assert.rejects(store.download('object',join(dir,'too-large'),1),/limit/);assert.equal(existsSync(join(dir,'too-large')),false);
});
test('automatic cleanup removes only registered work after verified upload and preserves unknown folders',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-owned-work-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const dataDir=join(dir,'data'),workDir=join(dir,'work');mkdirSync(dataDir);mkdirSync(workDir);const foreign=join(workDir,'ops-1000000000000-11111111-1111-1111-1111-111111111111');mkdirSync(foreign);writeFileSync(join(foreign,'keep'),'user file');
 let now=2000000000000;const r=new BackupRunner({dataDir,workDir,statePath:join(dataDir,'state.json'),store:{uploadVerified:async()=>{}},key,now:()=>now,log(){}});await r.tick();const old=r.state.lastRemoteId;now+=86400001;await r.tick();assert.equal(r.status().lastError,null);assert.equal(existsSync(join(workDir,old)),false);assert.equal(readFileSync(join(foreign,'keep'),'utf8'),'user file');
});
test('state write failures create an incident without pretending the backup succeeded',async()=>{
 const logs=[],r=new BackupRunner({store:{},key,log:v=>logs.push(JSON.parse(v))});r.save=()=>{throw Object.assign(new Error('private path'),{code:'ENOSPC'});};await r.tick();assert.equal(r.status().lastError,'ENOSPC');assert.equal(r.status().lastSuccess,null);assert.equal(logs[0].code,'ENOSPC');assert.ok(!JSON.stringify(logs).includes('private path'));
});
