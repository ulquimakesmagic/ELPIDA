import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createReadStream,createWriteStream,openSync,readSync,closeSync,statSync,unlinkSync} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline,finished} from 'node:stream/promises';
export function backupKey(value){if(!/^[a-fA-F0-9]{64}$/.test(value??''))throw new Error('Configure a 32-byte hexadecimal backup encryption key.');return Buffer.from(value,'hex');}
export async function encryptBackupFile(source,target,key,aad){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));const out=createWriteStream(target,{flags:'wx',mode:0o600});out.write(Buffer.concat([Buffer.from('ELP1'),iv]));
 await pipeline(createReadStream(source),cipher,out,{end:false});out.end(cipher.getAuthTag());await finished(out);
}
export async function decryptBackupFile(source,target,key,aad){
 const size=statSync(source).size;if(size<32)throw new Error('Invalid encrypted backup.');const fd=openSync(source,'r'),header=Buffer.alloc(16),tag=Buffer.alloc(16);try{readSync(fd,header,0,16,0);readSync(fd,tag,0,16,size-16);}finally{closeSync(fd);}
 if(header.subarray(0,4).toString()!=='ELP1')throw new Error('Unsupported encrypted backup.');const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(4));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);
 const out=createWriteStream(target,{flags:'wx',mode:0o600});let created=false;out.once('open',()=>{created=true;});try{await pipeline(size===32?Readable.from([]):createReadStream(source,{start:16,end:size-17}),decipher,out);}catch(error){if(created)unlinkSync(target);throw error;}
}
export async function fileHash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
