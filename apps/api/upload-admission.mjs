import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {keccak256,toUtf8Bytes} from 'ethers';

const hash=value=>createHash('sha256').update(value).digest('hex');
const reject=message=>Object.assign(new Error(message),{status:429});
// Durable admission, separate from wallet authorization. Proxy headers are never trusted.
export class UploadAdmission {
 constructor({path=':memory:',now=Date.now,difficulty=3}={}){
  if(!Number.isInteger(difficulty)||difficulty<1||difficulty>4)throw new Error('Invalid upload proof difficulty');
  this.now=now;this.difficulty=difficulty;this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS windows(k TEXT PRIMARY KEY,n INTEGER NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,digest TEXT,client TEXT,transport TEXT,expires INTEGER);');
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 count(scope,period,limit){const time=this.now(),k=scope+':'+Math.floor(time/period);const n=this.db.prepare('SELECT n FROM windows WHERE k=?').get(k)?.n??0;if(n>=limit)throw reject('Upload admission limit reached. Wait before retrying; no launch was submitted.');this.db.prepare('INSERT INTO windows VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET n=n+1').run(k,1,time+period);}
 issue({digest,client,transport}){
  if(!/^0x[0-9a-f]{64}$/.test(digest)||!client||!transport)throw Object.assign(new Error('Invalid upload request.'),{status:400});
  return this.transaction(()=>{this.db.prepare('DELETE FROM challenges WHERE expires<?').run(this.now());this.db.prepare('DELETE FROM windows WHERE expires<?').run(this.now());
   this.count('challenge:'+hash(transport),60000,60);this.count('challenge:global',86400000,2000);
   const id=randomBytes(24).toString('hex'),expires=this.now()+120000;
   this.db.prepare('INSERT INTO challenges VALUES(?,?,?,?,?)').run(id,digest,hash(client),hash(transport),expires);
   return {id,digest,expires,difficulty:this.difficulty};
  });
 }
 consume({id,nonce,client,transport}){
  if(!/^[a-f0-9]{48}$/.test(id??'')||!/^\d{1,9}$/.test(nonce??''))throw Object.assign(new Error('Prepare the upload again. No launch was submitted.'),{status:403});
  return this.transaction(()=>{const row=this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id);
   if(!row||row.expires<this.now()||row.client!==hash(client)||!keccak256(toUtf8Bytes(`${id}:${row.digest}:${nonce}`)).slice(2).startsWith('0'.repeat(this.difficulty)))throw Object.assign(new Error('Upload proof is expired or invalid. Prepare it again.'),{status:403});
   this.count('upload:client:'+row.client,3600000,10);this.count('upload:transport:'+row.transport,3600000,50);this.count('upload:global',60000,20);this.count('upload:daily',86400000,1000);
   this.db.prepare('DELETE FROM challenges WHERE id=?').run(id);return row.digest;
  });
 }
 close(){this.db.close();}
}
