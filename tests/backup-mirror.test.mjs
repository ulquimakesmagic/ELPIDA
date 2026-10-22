// Mainnet checklist C5: backups also go to a second provider, so an outage at the host (Railway) cannot take the
// backups with it. The mirror never weakens the primary backup, and a restore can read from either bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {backupKey} from '../apps/api/backup-encryption.mjs';
import {BackupRunner,configuredBackup,mirrorFrom} from '../apps/api/backup-runner.mjs';
import {restoreOffsite} from '../apps/api/offsite-restore.mjs';
import {MetadataStore} from '../apps/api/metadata-store.mjs';
import {evaluateOperations} from '../apps/api/operations-health.mjs';
import {productionGuard} from '../apps/api/production-guard.mjs';

const key=backupKey('cd'.repeat(32));
const bucket=()=>{const objects=new Map(),s={objects,fail:false,uploadVerified:async(k,f)=>{if(s.fail)throw Object.assign(new Error('mirror down'),{code:'TimeoutError'});objects.set(k,readFileSync(f));},download:async(k,f)=>{if(!objects.has(k))throw new Error('Missing remote object');writeFileSync(f,objects.get(k),{flag:'wx'});},close(){}};return s;};
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'elpida-mirror-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const dataDir=join(dir,'data');mkdirSync(dataDir);
 const published=await new MetadataStore({path:join(dataDir,'ipfs-content'),jwt:null}).publish({name:'Mirror',symbol:'MIR',description:'Survives a host outage'});
 return {dir,dataDir,published};
}

test('every verified snapshot is copied to the mirror, manifest last, and restores from the mirror alone', async t=>{
 const {dir,dataDir,published}=await fixture(t),primary=bucket(),mirror=bucket(),logs=[];let now=2000000000000;
 const r=new BackupRunner({dataDir,statePath:join(dataDir,'ops-backup-state.json'),workDir:join(dir,'work'),store:primary,mirror,key,now:()=>now,log:v=>logs.push(JSON.parse(v))});
 await r.tick();
 const s=r.status();assert.equal(s.lastError,null);assert.equal(s.mirror.enabled,true);assert.equal(s.mirror.lastError,null);assert.equal(s.mirror.current,true);
 assert.deepEqual([...mirror.objects.keys()],[...primary.objects.keys()],'same objects, same order');
 assert.ok([...mirror.objects.keys()].at(-1).endsWith('MANIFEST.json.enc'),'manifest is published last on the mirror too');
 assert.deepEqual(logs.map(l=>l.event),['backup_verified','backup_mirror_verified']);
 // Railway is down: restore from the mirror only.
 const restored=join(dir,'restored-from-mirror');
 await restoreOffsite({store:mirror,key,snapshotId:r.state.lastRemoteId,destination:restored,workRoot:join(dir,'restore-work')});
 assert.equal((await new MetadataStore({path:join(restored,'ipfs-content'),jwt:null}).resolve(published.uri)).description,'Survives a host outage');
});

test('a mirror outage never fails the primary backup, is reported as a warning, and is retried hourly', async t=>{
 const {dir,dataDir}=await fixture(t),primary=bucket(),mirror=bucket(),logs=[];let now=2000000000000;mirror.fail=true;
 const opts={dataDir,statePath:join(dataDir,'ops-backup-state.json'),workDir:join(dir,'work'),store:primary,mirror,key,now:()=>now,log:v=>logs.push(JSON.parse(v))};
 let r=new BackupRunner(opts);await r.tick();
 assert.equal(r.status().lastError,null,'primary succeeded');assert.equal(r.status().mirror.lastError,'TimeoutError');assert.equal(r.status().mirror.current,false);
 assert.ok(logs.some(l=>l.event==='backup_mirror_failed'&&l.code==='TimeoutError'));assert.ok(!JSON.stringify(logs).includes('mirror down'),'no raw error text is logged');
 const ops=evaluateOperations({now:now+3600000*4,startedAt:0,durable:true,backup:r.status()});
 assert.equal(ops.status,'degraded');assert.deepEqual(ops.incidents.map(i=>[i.code,i.severity]),[['backup_mirror_failed','warning']]);
 const primaryCount=primary.objects.size;
 now+=60000;mirror.fail=false;await r.tick();assert.equal(mirror.objects.size,0,'no retry within the hour');
 now+=3600000;r=new BackupRunner(opts);await r.tick();   // also survives a restart
 assert.equal(r.status().mirror.lastError,null);assert.equal(r.status().mirror.current,true);assert.equal(mirror.objects.size,primaryCount);
 assert.equal(primary.objects.size,primaryCount,'the retry copies the existing snapshot; it does not take a new one');
 assert.equal(evaluateOperations({now:now+60000,startedAt:0,durable:true,backup:r.status()}).status,'ok');
});

test('mirror configuration: all or nothing, another provider, and a bad mirror never disables the primary', ()=>{
 const base={ELPIDA_BACKUP_ENABLED:'true',ELPIDA_BACKUP_S3_ENDPOINT:'https://storage.railway.app',ELPIDA_BACKUP_S3_BUCKET:'elpida-backups',ELPIDA_BACKUP_S3_ACCESS_KEY_ID:'a',ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY:'b',ELPIDA_BACKUP_ENCRYPTION_KEY:'cd'.repeat(32)};
 const mirror={ELPIDA_BACKUP_MIRROR_S3_ENDPOINT:'https://0123456789abcdef.r2.cloudflarestorage.com',ELPIDA_BACKUP_MIRROR_S3_BUCKET:'elpida-mirror',ELPIDA_BACKUP_MIRROR_S3_ACCESS_KEY_ID:'c',ELPIDA_BACKUP_MIRROR_S3_SECRET_ACCESS_KEY:'d'};
 assert.equal(mirrorFrom(base),null);
 assert.equal(configuredBackup({env:base}).status().mirror.enabled,false);
 const full=configuredBackup({env:{...base,...mirror}}).status();assert.equal(full.enabled,true);assert.equal(full.mirror.enabled,true);assert.equal(full.mirror.lastError,null);
 assert.throws(()=>mirrorFrom({...base,ELPIDA_BACKUP_MIRROR_S3_ENDPOINT:mirror.ELPIDA_BACKUP_MIRROR_S3_ENDPOINT}),/Incomplete/);
 assert.throws(()=>mirrorFrom({...base,...mirror,ELPIDA_BACKUP_MIRROR_S3_ENDPOINT:'https://storage.railway.app'}),/different provider/);
 const partial=configuredBackup({env:{...base,ELPIDA_BACKUP_MIRROR_S3_BUCKET:'x'}}).status();
 assert.equal(partial.enabled,true);assert.equal(partial.lastError,null,'the primary backup still runs');assert.equal(partial.mirror.lastError,'BACKUP_MIRROR_CONFIGURATION');
 assert.deepEqual(evaluateOperations({startedAt:0,durable:true,backup:{...partial,lastSuccess:new Date().toISOString()}}).incidents.map(i=>i.code),['backup_mirror_failed']);
});

test('the mainnet guard notes single-provider backups without blocking', ()=>{
 const solana={mainnet:true,deployment:{programId:'x',build:'mainnet'}},env={SOLANA_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=k',ELPIDA_PUBLIC_URL:'https://elpida.fun',PINATA_JWT:'j',ELPIDA_DATA_DIR:'/data',ELPIDA_BACKUP_ENABLED:'true'};
 const single=productionGuard({env,solana});assert.ok(single.warnings.some(w=>w.code==='backup_single_provider'));assert.ok(!single.errors.some(e=>/backup/.test(e.code)));
 assert.ok(!productionGuard({env:{...env,ELPIDA_BACKUP_MIRROR_S3_ENDPOINT:'https://x.r2.cloudflarestorage.com'},solana}).warnings.some(w=>w.code==='backup_single_provider'));
});
