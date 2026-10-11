import test from 'node:test';
import assert from 'node:assert/strict';
import {XVerification} from '../apps/api/x-verification.mjs';
test('X claims require state, cookie binding, PKCE and the allocated authenticated profile',async()=>{
 let username='community',calls=[];
 const verifier=new XVerification({clientId:'test-client',redirectUri:'http://localhost:3000/api/rewards/x/callback',fetcher:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/token')?{access_token:'test-token'}:{data:{id:'123',username}}};}});
 const claim={target:'community',wallet:'0x123',token:'0x456'};
 const start=verifier.begin(claim),url=new URL(start.url),state=url.searchParams.get('state');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'tweet.read users.read');
 await assert.rejects(verifier.complete({state,code:'test',cookie:'wrong'}),/expired/);
 const result=await verifier.complete({state,code:'test',cookie:start.cookie});assert.equal(result.xUserId,'123');
 assert.ok(calls[0].options.body.get('code_verifier'));assert.equal(calls[1].options.headers.authorization,'Bearer test-token');
 await assert.rejects(verifier.complete({state,code:'test',cookie:start.cookie}),/expired/);
 username='imposter';const bad=verifier.begin(claim);await assert.rejects(verifier.complete({state:new URL(bad.url).searchParams.get('state'),code:'test',cookie:bad.cookie}),/named/);
 const disabled=new XVerification({clientId:'',redirectUri:''});assert.throws(()=>disabled.begin(claim),/Configure/);
});
