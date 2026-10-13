import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync,lstatSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {validCid} from './metadata-store.mjs';

const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const publicFile=p=>/^public-[0-9]+-0x[a-fA-F0-9]{40}\.sqlite$/.test(p)||/^public-metadata-[0-9]+-0x[a-fA-F0-9]{40}\.json$/.test(p)||/^public-solana-(devnet|mainnet|localnet)-[1-9A-HJ-NP-Za-km-z]{32,44}\.sqlite$/.test(p);
const allowed=p=>p==='ipfs-content/retention.json'||p.startsWith('ipfs-content/')&&p.endsWith('.json')&&validCid(p.slice(13,-5))||publicFile(p);
export const allowedBackupPath=allowed;
function checked(root,p){if(!allowed(p))throw new Error('Backup contains an unexpected file path.');const file=resolve(root,p);if(!file.startsWith(resolve(root)+'/')&&!file.startsWith(resolve(root)+'\\'))throw new Error('Backup path escaped its directory.');let part=resolve(root);for(const name of p.split('/')){part=join(part,name);if(lstatSync(part).isSymbolicLink())throw new Error('Backup symlinks are not supported.');}return file;}
export async function createPublicBackup(dataDir,destination){
 dataDir=resolve(dataDir);destination=resolve(destination);if(existsSync(destination))throw new Error('Backup destination already exists. Refusing to overwrite.');
 if(destination.startsWith(dataDir+'/')||destination.startsWith(dataDir+'\\')||destination===dataDir)throw new Error('Backup must be outside the live data directory.');
 mkdirSync(destination,{recursive:true});const files=[];
 // SQLite online backup includes committed WAL state without copying live WAL files.
 for(const name of readdirSync(dataDir).filter(publicFile)){const source=checked(dataDir,name),target=join(destination,name);if(name.endsWith('.sqlite')){const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);}finally{db.close();}}else copyFileSync(source,target);files.push(name);}
 const content=join(dataDir,'ipfs-content'),ledger=join(content,'retention.json'),before=existsSync(ledger)?digest(ledger):null;
 if(existsSync(content))for(const name of readdirSync(content)){const p='ipfs-content/'+name;if(!allowed(p))continue;const source=checked(dataDir,p),target=join(destination,p);mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);files.push(p);}
 if((existsSync(ledger)?digest(ledger):null)!==before)throw new Error('Retention changed during backup. Retry into a fresh destination; this snapshot is incomplete.');
 const manifest={schema:'elpida-public-backup-v1',createdAt:new Date().toISOString(),scope:'Metadata including provisional drafts and public index databases; excludes Circle credentials, wallets and private simulation state',files:files.map(path=>({path,sha256:digest(join(destination,path))}))};
 writeFileSync(join(destination,'MANIFEST.json'),JSON.stringify(manifest,null,2));return manifest;
}
export function restorePublicBackup(snapshot,destination){
 snapshot=resolve(snapshot);destination=resolve(destination);if(existsSync(destination))throw new Error('Restore destination already exists. Refusing to overwrite.');
 const manifest=JSON.parse(readFileSync(join(snapshot,'MANIFEST.json'),'utf8'));if(manifest.schema!=='elpida-public-backup-v1'||!Array.isArray(manifest.files))throw new Error('Unsupported or incomplete backup.');
 const seen=new Set();for(const f of manifest.files){if(seen.has(f.path))throw new Error('Duplicate backup entry.');seen.add(f.path);const source=checked(snapshot,f.path);if(!/^[a-f0-9]{64}$/.test(f.sha256)||digest(source)!==f.sha256)throw new Error('Backup integrity check failed. Nothing restored.');}
 mkdirSync(destination,{recursive:true});for(const f of manifest.files){const target=join(destination,f.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(checked(snapshot,f.path),target);}return manifest;
}
export function cleanupDuplicateTemps(contentDir,{apply=false,now=Date.now(),minimumAge=86400000}={}){
 contentDir=resolve(contentDir);const report=[];
 for(const name of readdirSync(contentDir)){if(!name.endsWith('.json.tmp')||!validCid(name.slice(0,-9)))continue;const temp=join(contentDir,name),committed=temp.slice(0,-4);if(lstatSync(temp).isSymbolicLink()||now-lstatSync(temp).mtimeMs<minimumAge||!existsSync(committed)||lstatSync(committed).isSymbolicLink())continue;if(digest(temp)!==digest(committed))continue;
  // Both absolute targets are constrained to this explicit content directory. Only duplicate files are removed.
  if(dirname(temp)!==contentDir||dirname(committed)!==contentDir)throw new Error('Cleanup target escaped its directory.');if(apply)unlinkSync(temp);report.push({name,action:apply?'removed duplicate temporary file':'would remove duplicate temporary file'});
 }
 return report;
}
