import {existsSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {decryptBackupFile} from './backup-encryption.mjs';
import {allowedBackupPath,restorePublicBackup} from './storage-operations.mjs';
export async function restoreOffsite({store,key,snapshotId,destination,workRoot}){
 if(!/^ops-\d{13}-[a-f0-9-]{36}$/.test(snapshotId))throw new Error('Invalid off-site snapshot identifier');if(existsSync(destination))throw new Error('Restore destination exists. Refusing to overwrite.');
 mkdirSync(workRoot,{recursive:true});const work=mkdtempSync(join(resolve(workRoot),'restore-')),plain=join(work,'snapshot');mkdirSync(plain);
 const manifestKey='elpida-backups/'+snapshotId+'/MANIFEST.json.enc',sealed=join(work,'manifest.enc');await store.download(manifestKey,sealed,16*1024*1024);await decryptBackupFile(sealed,join(plain,'MANIFEST.json'),key,manifestKey);
 const manifest=JSON.parse(readFileSync(join(plain,'MANIFEST.json'),'utf8'));if(manifest.schema!=='elpida-public-backup-v1'||!Array.isArray(manifest.files)||manifest.files.length>50000)throw new Error('Invalid backup manifest');const seen=new Set();for(const f of manifest.files){if(!allowedBackupPath(f.path)||seen.has(f.path))throw new Error('Unsafe backup entry');seen.add(f.path);}
 for(const [i,f] of manifest.files.entries()){const objectKey='elpida-backups/'+snapshotId+'/'+f.path+'.enc',encrypted=join(work,String(i)+'.enc'),target=join(plain,f.path);await store.download(objectKey,encrypted);mkdirSync(dirname(target),{recursive:true});await decryptBackupFile(encrypted,target,key,objectKey);}
 restorePublicBackup(plain,destination);return {files:manifest.files.length,destination:resolve(destination),scope:manifest.scope,temporaryDirectory:work};
}
