import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {verifyMessage,getAddress} from 'ethers';
import {PublicKey} from '@solana/web3.js';
export function thesisIdentity(network,token,author){
 if(!/^(local|[a-z][a-z0-9-]{1,40})$/.test(network??''))throw new Error('Invalid network');
 const sol=network.startsWith('solana-'),normal=v=>sol?new PublicKey(v).toBase58():getAddress(v).toLowerCase();return {network,token:normal(token),author:normal(author),sol};
}
export class HolderTheses{
 constructor({path=':memory:',origin='http://localhost',now=Date.now,holding}){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.origin=origin;this.now=now;this.holding=holding;
  this.db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS thesis_revisions(network TEXT,token TEXT,author TEXT,version INTEGER,text TEXT,created INTEGER,PRIMARY KEY(network,token,author,version));CREATE TABLE IF NOT EXISTS thesis_challenges(nonce TEXT PRIMARY KEY,network TEXT,token TEXT,author TEXT,version INTEGER,digest TEXT,expires INTEGER,message TEXT);`);
 }
 latest(i){return this.db.prepare('SELECT version,text,created FROM thesis_revisions WHERE network=? AND token=? AND author=? ORDER BY version DESC LIMIT 1').get(i.network,i.token,i.author)??null;}
 text(value){if(typeof value!=='string'||!value.trim()||value.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error('Write a thesis between 1 and 2,000 characters.');return value.trim();}
 async prepare(body){const i=thesisIdentity(body.network,body.token,body.author),text=this.text(body.text),now=this.now();this.db.prepare('DELETE FROM thesis_challenges WHERE expires<?').run(now);if(this.db.prepare('SELECT COUNT(*) AS n FROM thesis_challenges').get().n>=1000)throw new Error('Thesis signing is busy. Retry in a few minutes.');
  const latest=this.latest(i);if(latest&&now-latest.created<60000)throw new Error('Wait one minute before updating your thesis.');if((latest?.version??0)>=100)throw new Error('This thesis has reached its 100-version limit.');if(!(await this.holding(i)))throw new Error('Hold this token in the selected wallet to publish a thesis.');
  if(this.db.prepare('SELECT COUNT(*) AS n FROM thesis_revisions').get().n>=10000)throw new Error('Thesis storage is full. Contact Elpida support.');
  const version=(latest?.version??0)+1,nonce=randomBytes(24).toString('hex'),digest=createHash('sha256').update(text).digest('hex'),expires=now+300000;
  const message=`Elpida holder thesis\nSite: ${this.origin}\nNetwork: ${i.network}\nToken: ${i.token}\nWallet: ${i.author}\nVersion: ${version}\nText SHA-256: ${digest}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nThesis:\n${text}\nEnd of thesis.\nPublish this thesis publicly and preserve its earlier versions. This signature does not authorize a token transfer or approval.`;
  this.db.prepare('DELETE FROM thesis_challenges WHERE network=? AND token=? AND author=?').run(i.network,i.token,i.author);this.db.prepare('INSERT INTO thesis_challenges VALUES(?,?,?,?,?,?,?,?)').run(nonce,i.network,i.token,i.author,version,digest,expires,message);return {message,nonce,version,expires};
 }
 async save(body){const i=thesisIdentity(body.network,body.token,body.author),text=this.text(body.text),c=this.db.prepare('SELECT * FROM thesis_challenges WHERE nonce=?').get(String(body.nonce??''));if(!c||c.expires<this.now()||c.network!==i.network||c.token!==i.token||c.author!==i.author||c.digest!==createHash('sha256').update(text).digest('hex'))throw new Error('Thesis signing request expired or changed. Prepare it again.');
  let valid=false;try{if(i.sol){const signature=Buffer.from(body.signature,'base64'),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(i.author).toBuffer()]),format:'der',type:'spki'});valid=signature.length===64&&verify(null,Buffer.from(c.message),key,signature);}else valid=verifyMessage(c.message,body.signature).toLowerCase()===i.author;}catch{}if(!valid)throw new Error('The selected wallet must sign this thesis.');if(!(await this.holding(i)))throw new Error('You no longer hold this token.');
  this.db.exec('BEGIN IMMEDIATE');try{if(c.expires<this.now()||!this.db.prepare('SELECT nonce FROM thesis_challenges WHERE nonce=?').get(c.nonce)||(this.latest(i)?.version??0)+1!==c.version)throw new Error('Your thesis changed. Reload before editing.');if(this.db.prepare('SELECT COUNT(*) AS n FROM thesis_revisions').get().n>=10000)throw new Error('Thesis storage is full.');this.db.prepare('INSERT INTO thesis_revisions VALUES(?,?,?,?,?,?)').run(i.network,i.token,i.author,c.version,text,this.now());this.db.prepare('DELETE FROM thesis_challenges WHERE nonce=?').run(c.nonce);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return {saved:true,version:c.version};
 }
 list(network,token){return this.db.prepare('SELECT author,version,text,created FROM thesis_revisions r WHERE network=? AND token=? AND version=(SELECT MAX(version) FROM thesis_revisions WHERE network=r.network AND token=r.token AND author=r.author) LIMIT 1000').all(network,token);}
 history(i){return this.db.prepare('SELECT version,text,created FROM thesis_revisions WHERE network=? AND token=? AND author=? ORDER BY version DESC LIMIT 100').all(i.network,i.token,i.author);}
 close(){this.db.close();}
}
