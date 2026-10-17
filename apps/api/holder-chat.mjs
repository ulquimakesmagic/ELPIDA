import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {verifyMessage} from 'ethers';
import {PublicKey} from '@solana/web3.js';
import {thesisIdentity} from './holder-theses.mjs';

/** Public append-only chat. Posting requires a fresh holder check and wallet signature. */
export class HolderChat {
 constructor({path=':memory:',origin,holding,now=Date.now,maxMessages=50000}={}){
  if(typeof holding!=='function')throw new Error('Live holding reader required.');
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  Object.assign(this,{origin,holding,now,maxMessages});this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,network TEXT NOT NULL,token TEXT NOT NULL,author TEXT NOT NULL,text TEXT NOT NULL,reply_to INTEGER,created INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS chat_room ON chat_messages(network,token,id);
   CREATE INDEX IF NOT EXISTS chat_author ON chat_messages(network,token,author,created);
   CREATE TABLE IF NOT EXISTS chat_challenges(nonce TEXT PRIMARY KEY,network TEXT,token TEXT,author TEXT,digest TEXT,reply_to INTEGER,expires INTEGER);`);
 }
 text(value){if(typeof value!=='string'||!value.trim()||value.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error('Write a message between 1 and 1,000 characters.');return value.trim();}
 reply(i,value){if(value==null)return null;if(!Number.isSafeInteger(value)||value<1||!this.db.prepare('SELECT id FROM chat_messages WHERE id=? AND network=? AND token=?').get(value,i.network,i.token))throw new Error('Reply target is not in this token chat.');return value;}
 capacity(){if(this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n>=this.maxMessages)throw new Error('Chat storage is full.');}
 cooldown(i){const last=this.db.prepare('SELECT created FROM chat_messages WHERE network=? AND token=? AND author=? ORDER BY id DESC LIMIT 1').get(i.network,i.token,i.author);if(last&&this.now()-last.created<15000)throw new Error('Wait 15 seconds before posting another message.');}
 signingMessage(i,text,replyTo,nonce,expires){
  const site=typeof this.origin==='function'?this.origin():this.origin;
  const digest=createHash('sha256').update(text).digest('hex');
  return `Elpida holder chat\nSite: ${site}\nNetwork: ${i.network}\nToken: ${i.token}\nWallet: ${i.author}\nReply to: ${replyTo??'none'}\nText SHA-256: ${digest}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nMessage:\n${text}\nEnd of message.\nPublish this message publicly. This signature does not authorize a token transfer or approval.`;
 }
 async prepare(body){
  const i=thesisIdentity(body.network,body.token,body.author),text=this.text(body.text),replyTo=this.reply(i,body.replyTo),now=this.now();
  this.db.prepare('DELETE FROM chat_challenges WHERE expires<=?').run(now);this.capacity();this.cooldown(i);
  if(this.db.prepare('SELECT COUNT(*) AS n FROM chat_challenges').get().n>=1000)throw new Error('Chat signing is busy. Retry shortly.');
  if(!await this.holding(i))throw new Error('Hold this token in the selected wallet to post in chat.');
  if(this.db.prepare('SELECT COUNT(*) AS n FROM chat_challenges').get().n>=1000)throw new Error('Chat signing is busy. Retry shortly.');
  const nonce=randomBytes(24).toString('hex'),digest=createHash('sha256').update(text).digest('hex'),expires=now+300000;
  const message=this.signingMessage(i,text,replyTo,nonce,expires);
  this.db.prepare('INSERT INTO chat_challenges VALUES(?,?,?,?,?,?,?)').run(nonce,i.network,i.token,i.author,digest,replyTo,expires);
  return {message,nonce,expires};
 }
 async save(body){
  const i=thesisIdentity(body.network,body.token,body.author),text=this.text(body.text),replyTo=this.reply(i,body.replyTo),c=this.db.prepare('SELECT * FROM chat_challenges WHERE nonce=?').get(String(body.nonce??''));
  if(!c||c.expires<=this.now()||c.network!==i.network||c.token!==i.token||c.author!==i.author||c.reply_to!==replyTo||c.digest!==createHash('sha256').update(text).digest('hex'))throw new Error('Chat signing request expired or changed. Prepare it again.');
  const message=this.signingMessage(i,text,replyTo,c.nonce,c.expires);
  let valid=false;try{
   if(i.sol){const signature=Buffer.from(body.signature,'base64'),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(i.author).toBuffer()]),format:'der',type:'spki'});valid=signature.length===64&&verify(null,Buffer.from(message),key,signature);}
   else valid=verifyMessage(message,body.signature).toLowerCase()===i.author;
  }catch{}
  if(!valid)throw new Error('The selected wallet must sign this chat message.');
  if(!await this.holding(i))throw new Error('You no longer hold this token.');
  this.db.exec('BEGIN IMMEDIATE');try{
   if(c.expires<=this.now()||!this.db.prepare('SELECT nonce FROM chat_challenges WHERE nonce=?').get(c.nonce))throw new Error('Chat signing request expired or already used.');
   this.capacity();this.cooldown(i);
   const result=this.db.prepare('INSERT INTO chat_messages(network,token,author,text,reply_to,created) VALUES(?,?,?,?,?,?)').run(i.network,i.token,i.author,text,replyTo,this.now());
   this.db.prepare('DELETE FROM chat_challenges WHERE nonce=?').run(c.nonce);this.db.exec('COMMIT');return {saved:true,id:Number(result.lastInsertRowid)};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 list(network,token,{before=null,limit=50}={}){
  const i=thesisIdentity(network,token,token);
  if(before!==null&&(!Number.isSafeInteger(before)||before<1)||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid chat page.');
  const rows=this.db.prepare('SELECT id,author,text,reply_to AS replyTo,created FROM chat_messages WHERE network=? AND token=? AND id<? ORDER BY id DESC LIMIT ?').all(i.network,i.token,before??Number.MAX_SAFE_INTEGER,limit+1);
  const more=rows.length>limit;if(more)rows.pop();rows.reverse();
  return {messages:rows.map(row=>({...row,reply:row.replyTo?this.db.prepare('SELECT id,author,substr(text,1,160) AS text FROM chat_messages WHERE id=? AND network=? AND token=?').get(row.replyTo,i.network,i.token):null})),nextBefore:more?rows[0].id:null};
 }
 close(){this.db.close();}
}
