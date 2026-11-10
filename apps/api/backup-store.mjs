import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectsCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {createReadStream,createWriteStream,statSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createHash} from 'node:crypto';
export class BackupStore{
 constructor({endpoint,bucket,region='auto',accessKeyId,secretAccessKey,pathStyle=false,client}={}){
  const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Invalid backup endpoint');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket??''))throw new Error('Invalid backup bucket');this.bucket=bucket;
  this.client=client??new S3Client({endpoint:url.origin,region,forcePathStyle:pathStyle,credentials:{accessKeyId,secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:2});
 }
 async uploadVerified(key,file,expectedHash){
  await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:createReadStream(file),ContentLength:statSync(file).size,ContentType:'application/octet-stream',Metadata:{sha256:expectedHash}}),{abortSignal:AbortSignal.timeout(120000)});
  const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(120000)});const hash=createHash('sha256');let size=0;
  for await(const chunk of response.Body){size+=chunk.length;if(size>statSync(file).size)throw new Error('Backup readback size mismatch');hash.update(chunk);}
  if(size!==statSync(file).size||hash.digest('hex')!==expectedHash)throw new Error('Backup readback integrity failure');
 }
 async download(key,file,maxBytes=2*1024*1024*1024){
  const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(120000)});if(Number(response.ContentLength)>maxBytes)throw new Error('Backup object exceeds download limit');let size=0;
  const limiter=new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>maxBytes?new Error('Backup object exceeds download limit'):null,chunk);}});
  await pipeline(response.Body,limiter,createWriteStream(file,{flags:'wx',mode:0o600}));
 }
 async inventory(){
  const objects=[],seen=new Set();let token;
  do{
   const response=await this.client.send(new ListObjectsV2Command({Bucket:this.bucket,Prefix:'elpida-backups/',MaxKeys:1000,...(token?{ContinuationToken:token}:{})}),{abortSignal:AbortSignal.timeout(120000)});
   for(const object of response.Contents??[]){if(typeof object.Key!=='string'||!Number.isSafeInteger(object.Size)||object.Size<0)throw new Error('Invalid backup inventory');objects.push({key:object.Key,size:object.Size});if(objects.length>100000)throw new Error('Backup inventory exceeds review capacity');}
   if(!response.IsTruncated)break;
   token=response.NextContinuationToken;if(!token||seen.has(token))throw new Error('Invalid backup inventory pagination');seen.add(token);
  }while(true);
  return objects;
 }
 /** Deletes backup objects (only under elpida-backups/), in batches of up to 1,000; one at a time where the provider has no batch delete. */
 async deleteKeys(keys){
  if(keys.some(k=>typeof k!=='string'||!/^elpida-backups\/ops-\d{13}-[a-f0-9-]{36}\//.test(k)))throw new Error('Refusing to delete an object outside a backup snapshot');
  for(let i=0;i<keys.length;i+=1000){const part=keys.slice(i,i+1000);
   try{const r=await this.client.send(new DeleteObjectsCommand({Bucket:this.bucket,Delete:{Objects:part.map(Key=>({Key})),Quiet:true}}),{abortSignal:AbortSignal.timeout(120000)});if(r?.Errors?.length)throw new Error('Backup delete failed');}
   catch(error){if(error.message==='Backup delete failed')throw error;for(const Key of part)await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key}),{abortSignal:AbortSignal.timeout(120000)});}
  }
 }
 close(){this.client.destroy?.();}
}
