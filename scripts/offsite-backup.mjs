import {resolve} from 'node:path';
import {configuredBackup} from '../apps/api/backup-runner.mjs';
import {restoreOffsite} from '../apps/api/offsite-restore.mjs';
import {reviewRetention} from '../apps/api/backup-retention.mjs';
const [action,first,second]=process.argv.slice(2);if(!['run','restore','review'].includes(action)||action!=='review'&&!first||action==='restore'&&!second)throw new Error('Usage: offsite-backup.mjs run DATA_DIR | restore SNAPSHOT_ID NEW_DATA_DIR | review');
const workDir=resolve('backups/offsite-work'),runner=configuredBackup({env:{...process.env,ELPIDA_BACKUP_ENABLED:'true'},dataDir:resolve(first??'.'),statePath:action==='run'?resolve(first,'ops-backup-state.json'):null,workDir});
if(!runner.status().enabled)throw new Error('Configure backup bucket credentials and encryption key first. Do not paste credentials into chat.');
try{if(action==='review')console.log(JSON.stringify(reviewRetention(await runner.store.inventory())));else if(action==='run'){await runner.tick();if(runner.status().lastError)throw new Error('Off-site backup failed; inspect sanitized service logs.');console.log(JSON.stringify(runner.status()));}else console.log(JSON.stringify(await restoreOffsite({store:runner.store,key:runner.key,snapshotId:first,destination:resolve(second),workRoot:workDir})));}finally{await runner.close();}
