import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,rmSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {createPublicBackup} from './storage-operations.mjs';
import {encryptBackupFile,backupKey,fileHash} from './backup-encryption.mjs';
import {BackupStore} from './backup-store.mjs';

const ownName=n=>/^ops-\d{13}-[a-f0-9-]{36}$/.test(n);
const safeError=e=>['ENOSPC','EACCES','ENOENT','AccessDenied','NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','TimeoutError','AbortError'].find(c=>c===e.code||c===e.name)??'BACKUP_FAILED';
export class BackupRunner{
 constructor({dataDir,statePath,workDir,store,mirror=null,mirrorConfigurationError=null,key,intervalMs=86400000,now=Date.now,log=console.log,configurationError=null}={}){
  // mirror: an optional second bucket at a different provider, so a hosting outage does not also take the backups.
  this.dataDir=dataDir;this.statePath=statePath;this.workDir=workDir?resolve(workDir):null;this.store=store;this.mirror=store?mirror:null;this.mirrorConfigurationError=store?mirrorConfigurationError:null;this.key=key;this.intervalMs=intervalMs;this.now=now;this.log=log;this.state={lastAttempt:null,lastSuccess:null,lastError:configurationError,lastRemoteId:null,workIds:[],mirrorLastAttempt:null,mirrorLastSuccess:null,mirrorLastError:null,mirrorRemoteId:null};
  if(statePath&&existsSync(statePath))try{const saved=JSON.parse(readFileSync(statePath,'utf8'));for(const k of Object.keys(this.state))if(k in saved)this.state[k]=saved[k];if(this.state.mirrorRemoteId!==null&&!ownName(this.state.mirrorRemoteId))throw new Error('Invalid mirror state');if(!Array.isArray(this.state.workIds)||this.state.workIds.some(n=>!ownName(n)))throw new Error('Invalid work registry');if(configurationError)this.state.lastError=configurationError;}catch{this.store=null;this.state.lastError='BACKUP_STATE_INVALID';}
 }
 status(){return {enabled:!!this.store,running:!!this.running,intervalMs:this.intervalMs,lastAttempt:this.state.lastAttempt,lastSuccess:this.state.lastSuccess,lastError:this.state.lastError,mirror:{enabled:!!this.mirror||!!this.mirrorConfigurationError,lastAttempt:this.state.mirrorLastAttempt,lastSuccess:this.state.mirrorLastSuccess,lastError:this.mirrorConfigurationError??this.state.mirrorLastError,current:!!this.state.lastRemoteId&&this.state.mirrorRemoteId===this.state.lastRemoteId,reachable:this.mirrorReachable??null,checkedAt:this.mirrorCheckedAt??null,
   // The local copy of the latest snapshot is gone (the work folder does not survive a redeploy): the mirror gets the next one.
   waitingForNextBackup:!!this.mirror&&!!this.state.lastRemoteId&&this.state.mirrorRemoteId!==this.state.lastRemoteId&&!this.snapshotReady(this.state.lastRemoteId)}};}
 save(){if(this.statePath){mkdirSync(dirname(this.statePath),{recursive:true});writeFileSync(this.statePath+'.tmp',JSON.stringify(this.state));renameSync(this.statePath+'.tmp',this.statePath);}}
 async tick(){if(this.stopped||!this.store||this.running)return;if(this.mirror&&this.mirrorReachable===undefined){this.running=this.checkMirror();try{await this.running;}finally{this.running=null;}}const last=Date.parse(this.state.lastAttempt);if(Number.isFinite(last)&&this.now()-last<(this.state.lastError?3600000:this.intervalMs)){if(this.mirrorDue()){this.running=this.copyToMirror(this.state.lastRemoteId);try{await this.running;}finally{this.running=null;}}return;}this.running=this.run();try{await this.running;}finally{this.running=null;}}
 /** The latest verified snapshot is not on the mirror yet and the last mirror attempt was over an hour ago. */
 mirrorDue(){const s=this.state,last=Date.parse(s.mirrorLastAttempt);return !!this.mirror&&!!s.lastRemoteId&&s.mirrorRemoteId!==s.lastRemoteId&&s.workIds.includes(s.lastRemoteId)&&this.snapshotReady(s.lastRemoteId)&&(!Number.isFinite(last)||this.now()-last>=3600000);}
 /** The sealed local copy of a verified snapshot is still on disk (it is not after a redeploy: the work folder is temporary). */
 snapshotReady(id){return !!this.workDir&&ownName(id??'')&&existsSync(join(this.workDir,id,'snapshot','MANIFEST.json'))&&existsSync(join(this.workDir,id,'sealed','MANIFEST.json.enc'));}
 /**
  * Once per start: proves the mirror's endpoint, bucket and key work by writing a small random object and reading it
  * back, so a wrong key shows up within a minute instead of at the next daily backup. The object holds no data.
  */
 async checkMirror(){
  const probe=join(tmpdir(),'elpida-mirror-probe-'+randomUUID());this.mirrorCheckedAt=new Date(this.now()).toISOString();
  try{writeFileSync(probe,randomBytes(64),{flag:'wx'});await this.mirror.uploadVerified('elpida-mirror-check.bin',probe,await fileHash(probe));this.mirrorReachable=true;
   // An earlier attempt's error is superseded: the bucket and key work. Copying waits for a snapshot with local files.
   if(this.state.mirrorLastError){this.state.mirrorLastError=null;this.save();}this.log(JSON.stringify({event:'backup_mirror_reachable'}));}
  catch(error){this.mirrorReachable=false;this.state.mirrorLastError=safeError(error);try{this.save();}catch{/* reported through status */}this.log(JSON.stringify({event:'backup_mirror_unreachable',code:this.state.mirrorLastError}));}
  finally{rmSync(probe,{force:true});}
 }
 /** Copies one already-verified snapshot's sealed objects to the mirror, manifest last, each read back and hash-checked. A mirror failure is reported but never fails the primary backup. */
 async copyToMirror(id){
  this.state.mirrorLastAttempt=new Date(this.now()).toISOString();
  try{
   const sealedRoot=join(this.workDir,id,'sealed'),manifest=JSON.parse(readFileSync(join(this.workDir,id,'snapshot','MANIFEST.json'),'utf8'));
   for(const path of [...manifest.files.map(f=>f.path),'MANIFEST.json']){const objectKey='elpida-backups/'+id+'/'+path+'.enc',sealed=join(sealedRoot,path+'.enc');await this.mirror.uploadVerified(objectKey,sealed,await fileHash(sealed));}
   this.state.mirrorLastSuccess=new Date(this.now()).toISOString();this.state.mirrorLastError=null;this.state.mirrorRemoteId=id;this.save();this.log(JSON.stringify({event:'backup_mirror_verified',files:manifest.files.length+1}));
  }catch(error){this.state.mirrorLastError=safeError(error);try{this.save();}catch{/* reported through status */}this.log(JSON.stringify({event:'backup_mirror_failed',code:this.state.mirrorLastError}));}
 }
 async run(){
  this.state.lastAttempt=new Date(this.now()).toISOString();
  try{
   this.save();
   mkdirSync(this.workDir,{recursive:true});if(lstatSync(this.workDir).isSymbolicLink())throw new Error('Unsafe backup work directory');if(readdirSync(this.workDir).filter(ownName).length>=3)throw new Error('Backup work directory needs review');const previous=[...this.state.workIds];
   const id='ops-'+String(this.now())+'-'+randomUUID(),job=join(this.workDir,id),snapshot=join(job,'snapshot');mkdirSync(job);this.state.workIds.push(id);this.save();const manifest=await createPublicBackup(this.dataDir,snapshot);
   const entries=[...manifest.files.map(f=>f.path),'MANIFEST.json'];if(manifest.files.length>50000||statSync(join(snapshot,'MANIFEST.json')).size>16*1024*1024||entries.some(p=>statSync(join(snapshot,p)).size+32>2*1024*1024*1024))throw new Error('Snapshot exceeds verified restore capacity');
   for(const path of entries){const objectKey='elpida-backups/'+id+'/'+path+'.enc',sealed=join(job,'sealed',path+'.enc');mkdirSync(dirname(sealed),{recursive:true});await encryptBackupFile(join(snapshot,path),sealed,this.key,objectKey);await this.store.uploadVerified(objectKey,sealed,await fileHash(sealed));}
   // Manifest is uploaded last and read back; incomplete sets have no committed remote manifest.
   this.state.lastSuccess=new Date(this.now()).toISOString();this.state.lastError=null;this.state.lastRemoteId=id;this.save();this.log(JSON.stringify({event:'backup_verified',files:entries.length}));
   if(this.mirror)await this.copyToMirror(id);
   // Only remove our own local work folders after a newer off-site copy is verified.
   for(const name of previous){const target=resolve(this.workDir,name);if(!ownName(name)||dirname(target)!==this.workDir)throw new Error('Unsafe backup cleanup target');if(existsSync(target)){if(lstatSync(target).isSymbolicLink())throw new Error('Unsafe backup cleanup target');rmSync(target,{recursive:true,force:false});}}this.state.workIds=[id];this.save();
  }catch(error){this.state.lastError=safeError(error);try{this.save();}catch{/* Full or inaccessible volumes still produce a visible incident. */}this.log(JSON.stringify({event:'backup_failed',code:this.state.lastError}));}
 }
 start(){this.startTimer=setTimeout(()=>this.tick().catch(()=>{}),30000);this.startTimer.unref();this.timer=setInterval(()=>this.tick().catch(()=>{}),60000);this.timer.unref();return this;}
 async close(){this.stopped=true;clearTimeout(this.startTimer);clearInterval(this.timer);if(this.running)await this.running;this.store?.close?.();this.mirror?.close?.();}
}
const MIRROR='ELPIDA_BACKUP_MIRROR_S3_',REQUIRED=['ENDPOINT','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY'];
function storeFrom(env,prefix){return new BackupStore({endpoint:env[prefix+'ENDPOINT'],bucket:env[prefix+'BUCKET'],region:env[prefix+'REGION']??'auto',accessKeyId:env[prefix+'ACCESS_KEY_ID'],secretAccessKey:env[prefix+'SECRET_ACCESS_KEY'],pathStyle:env[prefix+'PATH_STYLE']==='true'});}
/** The optional mirror: all of its settings or none, and never the primary bucket again. Uses the same encryption key. */
export function mirrorFrom(env){
 const set=REQUIRED.filter(n=>env[MIRROR+n]);if(!set.length)return null;
 if(set.length<REQUIRED.length)throw new Error('Incomplete backup mirror configuration');
 if(new URL(env[MIRROR+'ENDPOINT']).host===new URL(env.ELPIDA_BACKUP_S3_ENDPOINT).host)throw new Error('The backup mirror must be at a different provider');
 return storeFrom(env,MIRROR);
}
export function configuredBackup({env=process.env,dataDir,statePath,workDir,log}={}){
 if(env.ELPIDA_BACKUP_ENABLED!=='true')return new BackupRunner({dataDir,statePath,workDir,log});
 try{
  for(const name of ['ELPIDA_BACKUP_S3_ENDPOINT','ELPIDA_BACKUP_S3_BUCKET','ELPIDA_BACKUP_S3_ACCESS_KEY_ID','ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY'])if(!env[name])throw new Error('Missing backup configuration');
  const intervalMs=Number(env.ELPIDA_BACKUP_INTERVAL_HOURS??24)*3600000;if(!Number.isSafeInteger(intervalMs)||intervalMs<3600000||intervalMs>7*86400000)throw new Error('Invalid backup interval');
  const key=backupKey(env.ELPIDA_BACKUP_ENCRYPTION_KEY),store=storeFrom(env,'ELPIDA_BACKUP_S3_');
  let mirror=null,mirrorConfigurationError=null;try{mirror=mirrorFrom(env);}catch{mirrorConfigurationError='BACKUP_MIRROR_CONFIGURATION';}
  return new BackupRunner({dataDir,statePath,workDir,log,key,store,mirror,mirrorConfigurationError,intervalMs});
 }catch{return new BackupRunner({dataDir,statePath,workDir,log,configurationError:'BACKUP_CONFIGURATION'});}
}
