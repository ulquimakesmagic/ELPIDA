import {keccak256,toUtf8Bytes} from '/vendor/ethers.js';

export async function solveUploadAdmission(payload,{signal}={}){
 const digest=keccak256(toUtf8Bytes(payload)),response=await fetch('/api/metadata/challenge?digest='+digest,{signal});
 const c=await response.json();if(!response.ok)throw new Error(c.error??'Could not prepare the upload.');
 if(!/^[a-f0-9]{48}$/.test(c.id??'')||c.digest!==digest||!Number.isInteger(c.difficulty)||c.difficulty<1||c.difficulty>4||!Number.isSafeInteger(c.expires))throw new Error('Invalid upload challenge.');
 const deadline=Date.now()+90000;
 for(let nonce=0;nonce<1000000;nonce++){
  if(nonce%256===0){if(signal?.aborted||Date.now()>deadline)throw new Error('Upload preparation expired. Try again; no launch was submitted.');await new Promise(r=>setTimeout(r,0));}
  if(keccak256(toUtf8Bytes(`${c.id}:${digest}:${nonce}`)).slice(2).startsWith('0'.repeat(c.difficulty)))return {'X-Elpida-Upload-Id':c.id,'X-Elpida-Upload-Nonce':String(nonce)};
 }
 throw new Error('Upload preparation could not finish. Try again; no launch was submitted.');
}
export function prepareUploadProof(payload,{signal}={}){
 if(typeof Worker==='undefined')return solveUploadAdmission(payload,{signal});
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new Error('Upload preparation cancelled.'));
  const worker=new Worker(new URL('./upload-proof-worker.mjs',import.meta.url),{type:'module'});
  const finish=(error,headers)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();error?reject(new Error(error)):resolve(headers);};
  const abort=()=>finish('Upload preparation cancelled.'),timer=setTimeout(()=>finish('Upload preparation timed out. Try again; no launch was submitted.'),90000);
  signal?.addEventListener('abort',abort,{once:true});worker.onmessage=event=>finish(event.data.error,event.data.headers);worker.onerror=()=>finish('Upload preparation could not start. Refresh Elpida and retry.');worker.postMessage(payload);
 });
}
