import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,rmSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPublicBackup} from './storage-operations.mjs';
import {encryptBackupFile,backupKey,fileHash} from './backup-encryption.mjs';
import {BackupStore} from './backup-store.mjs';

const ownName=n=>/^ops-\d{13}-[a-f0-9-]{36}$/.test(n);
const safeError=e=>['ENOSPC','EACCES','AccessDenied','NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','TimeoutError','AbortError'].find(c=>c===e.code||c===e.name)??'BACKUP_FAILED';
export class BackupRunner{
 constructor({dataDir,statePath,workDir,store,key,intervalMs=86400000,now=Date.now,log=console.log,configurationError=null}={}){
  this.dataDir=dataDir;this.statePath=statePath;this.workDir=workDir?resolve(workDir):null;this.store=store;this.key=key;this.intervalMs=intervalMs;this.now=now;this.log=log;this.state={lastAttempt:null,lastSuccess:null,lastError:configurationError,lastRemoteId:null,workIds:[]};
  if(statePath&&existsSync(statePath))try{const saved=JSON.parse(readFileSync(statePath,'utf8'));for(const k of Object.keys(this.state))if(k in saved)this.state[k]=saved[k];if(!Array.isArray(this.state.workIds)||this.state.workIds.some(n=>!ownName(n)))throw new Error('Invalid work registry');if(configurationError)this.state.lastError=configurationError;}catch{this.store=null;this.state.lastError='BACKUP_STATE_INVALID';}
 }
 status(){return {enabled:!!this.store,running:!!this.running,intervalMs:this.intervalMs,lastAttempt:this.state.lastAttempt,lastSuccess:this.state.lastSuccess,lastError:this.state.lastError};}
 save(){if(this.statePath){mkdirSync(dirname(this.statePath),{recursive:true});writeFileSync(this.statePath+'.tmp',JSON.stringify(this.state));renameSync(this.statePath+'.tmp',this.statePath);}}
 async tick(){if(this.stopped||!this.store||this.running)return;const last=Date.parse(this.state.lastAttempt);if(Number.isFinite(last)&&this.now()-last<(this.state.lastError?3600000:this.intervalMs))return;this.running=this.run();try{await this.running;}finally{this.running=null;}}
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
   // Only remove our own local work folders after a newer off-site copy is verified.
   for(const name of previous){const target=resolve(this.workDir,name);if(!ownName(name)||dirname(target)!==this.workDir)throw new Error('Unsafe backup cleanup target');if(existsSync(target)){if(lstatSync(target).isSymbolicLink())throw new Error('Unsafe backup cleanup target');rmSync(target,{recursive:true,force:false});}}this.state.workIds=[id];this.save();
  }catch(error){this.state.lastError=safeError(error);try{this.save();}catch{/* Full or inaccessible volumes still produce a visible incident. */}this.log(JSON.stringify({event:'backup_failed',code:this.state.lastError}));}
 }
 start(){this.startTimer=setTimeout(()=>this.tick().catch(()=>{}),30000);this.startTimer.unref();this.timer=setInterval(()=>this.tick().catch(()=>{}),60000);this.timer.unref();return this;}
 async close(){this.stopped=true;clearTimeout(this.startTimer);clearInterval(this.timer);if(this.running)await this.running;this.store?.close?.();}
}
export function configuredBackup({env=process.env,dataDir,statePath,workDir,log}={}){
 if(env.ELPIDA_BACKUP_ENABLED!=='true')return new BackupRunner({dataDir,statePath,workDir,log});
 try{
  for(const name of ['ELPIDA_BACKUP_S3_ENDPOINT','ELPIDA_BACKUP_S3_BUCKET','ELPIDA_BACKUP_S3_ACCESS_KEY_ID','ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY'])if(!env[name])throw new Error('Missing backup configuration');
  const intervalMs=Number(env.ELPIDA_BACKUP_INTERVAL_HOURS??24)*3600000;if(!Number.isSafeInteger(intervalMs)||intervalMs<3600000||intervalMs>7*86400000)throw new Error('Invalid backup interval');
  const key=backupKey(env.ELPIDA_BACKUP_ENCRYPTION_KEY),store=new BackupStore({endpoint:env.ELPIDA_BACKUP_S3_ENDPOINT,bucket:env.ELPIDA_BACKUP_S3_BUCKET,region:env.ELPIDA_BACKUP_S3_REGION??'auto',accessKeyId:env.ELPIDA_BACKUP_S3_ACCESS_KEY_ID,secretAccessKey:env.ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY,pathStyle:env.ELPIDA_BACKUP_S3_PATH_STYLE==='true'});
  return new BackupRunner({dataDir,statePath,workDir,log,key,store,intervalMs});
 }catch{return new BackupRunner({dataDir,statePath,workDir,log,configurationError:'BACKUP_CONFIGURATION'});}
}
