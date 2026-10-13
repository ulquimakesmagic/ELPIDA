import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const file=resolve('.env.backup-key');
if(existsSync(file)||existsSync('.env')&&/^ELPIDA_BACKUP_ENCRYPTION_KEY=.+$/m.test(readFileSync('.env','utf8')))throw new Error('A backup key already exists. Refusing to replace or rotate it.');
writeFileSync(file,'ELPIDA_BACKUP_ENCRYPTION_KEY='+randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});console.log('Backup key saved privately to '+file+'. Store it securely outside the Railway volume before activation.');
