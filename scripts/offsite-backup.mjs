import {resolve} from 'node:path';
import {configuredBackup} from '../apps/api/backup-runner.mjs';
import {restoreOffsite} from '../apps/api/offsite-restore.mjs';
import {reviewRetention} from '../apps/api/backup-retention.mjs';
const args=process.argv.slice(2),fromMirror=args.includes('--from-mirror'),[action,first,second]=args.filter(a=>a!=='--from-mirror');if(!['run','restore','review'].includes(action)||action!=='review'&&!first||action==='restore'&&!second||fromMirror&&action==='run')throw new Error('Usage: offsite-backup.mjs run DATA_DIR | restore SNAPSHOT_ID NEW_DATA_DIR [--from-mirror] | review [--from-mirror]');
// --from-mirror reads the second provider's bucket, for when the primary provider (Railway) is down. Only the
// ELPIDA_BACKUP_MIRROR_S3_* settings and the encryption key are needed on the machine doing the restore.
const env={...process.env,ELPIDA_BACKUP_ENABLED:'true'};
if(fromMirror){for(const n of ['ENDPOINT','BUCKET','REGION','ACCESS_KEY_ID','SECRET_ACCESS_KEY','PATH_STYLE']){if(env['ELPIDA_BACKUP_MIRROR_S3_'+n]!==undefined)env['ELPIDA_BACKUP_S3_'+n]=env['ELPIDA_BACKUP_MIRROR_S3_'+n];else delete env['ELPIDA_BACKUP_S3_'+n];delete env['ELPIDA_BACKUP_MIRROR_S3_'+n];}}
const workDir=resolve('backups/offsite-work'),runner=configuredBackup({env,dataDir:resolve(first??'.'),statePath:action==='run'?resolve(first,'ops-backup-state.json'):null,workDir});
if(!runner.status().enabled)throw new Error('Configure backup bucket credentials and encryption key first. Do not paste credentials into chat.');
try{if(action==='review')console.log(JSON.stringify(reviewRetention(await runner.store.inventory())));else if(action==='run'){await runner.tick();if(runner.status().lastError)throw new Error('Off-site backup failed; inspect sanitized service logs.');console.log(JSON.stringify(runner.status()));}else console.log(JSON.stringify(await restoreOffsite({store:runner.store,key:runner.key,snapshotId:first,destination:resolve(second),workRoot:workDir})));}finally{await runner.close();}
