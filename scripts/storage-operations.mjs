import {resolve} from 'node:path';
import {createPublicBackup,restorePublicBackup,cleanupDuplicateTemps} from '../apps/api/storage-operations.mjs';
const [action,source,target]=process.argv.slice(2);
if(!source||!['backup','restore','cleanup'].includes(action)||action!=='cleanup'&&!target)throw new Error('Usage: storage-operations.mjs backup DATA_DIR NEW_SNAPSHOT_DIR | restore SNAPSHOT_DIR NEW_DATA_DIR | cleanup CONTENT_DIR [--apply]');
const result=action==='backup'?await createPublicBackup(resolve(source),resolve(target)):action==='restore'?restorePublicBackup(resolve(source),resolve(target)):cleanupDuplicateTemps(resolve(source),{apply:target==='--apply'});
console.log(JSON.stringify({action,result},null,2));
