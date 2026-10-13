import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256,toUtf8Bytes} from 'ethers';
import {UploadAdmission} from '../apps/api/upload-admission.mjs';
const digest=keccak256(toUtf8Bytes('payload')),args={digest,client:'client',transport:'peer'};
const solve=c=>{let nonce=0;while(!keccak256(toUtf8Bytes(`${c.id}:${c.digest}:${nonce}`)).slice(2).startsWith('0'.repeat(c.difficulty)))nonce++;return String(nonce);};
test('upload proofs bind a payload and session, expire and cannot replay after restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-admission-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=1000;
 let a=new UploadAdmission({path:join(dir,'admission.sqlite'),now:()=>now,difficulty:1});const c=a.issue(args),nonce=solve(c);
 assert.throws(()=>a.consume({...args,id:c.id,nonce,client:'other'}));a.close();a=new UploadAdmission({path:join(dir,'admission.sqlite'),now:()=>now,difficulty:1});
 assert.equal(a.consume({...args,id:c.id,nonce,transport:'another-proxy-hop'}),digest);assert.throws(()=>a.consume({...args,id:c.id,nonce}));
 const expired=a.issue(args);now+=120001;assert.throws(()=>a.consume({...args,id:expired.id,nonce:solve(expired)}));a.close();
});
test('new sessions cannot bypass the transport upload budget',()=>{
 let now=2000000000;const a=new UploadAdmission({difficulty:1,now:()=>now});try{
  for(let i=0;i<50;i++){if(i%10===0)now+=61000;const client='client'+Math.floor(i/10),c=a.issue({...args,client});a.consume({...args,client,id:c.id,nonce:solve(c)});}
  const c=a.issue({...args,client:'new'});assert.throws(()=>a.consume({...args,client:'new',id:c.id,nonce:solve(c)}),/limit/);
 }finally{a.close();}
});
test('session counters survive a process restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'elpida-counter-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'limits.sqlite');
 let a=new UploadAdmission({path,difficulty:1});for(let i=0;i<10;i++){const c=a.issue(args);a.consume({...args,id:c.id,nonce:solve(c)});}a.close();
 a=new UploadAdmission({path,difficulty:1});try{const c=a.issue(args);assert.throws(()=>a.consume({...args,id:c.id,nonce:solve(c)}),/limit/);}finally{a.close();}
});
