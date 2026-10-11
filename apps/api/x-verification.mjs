import {randomBytes,createHash} from 'node:crypto';
// OAuth credentials and access tokens stay on the server. No posting scopes or refresh token storage.
export class XVerification {
 constructor({clientId=process.env.ELPIDA_X_CLIENT_ID,clientSecret=process.env.ELPIDA_X_CLIENT_SECRET,redirectUri=process.env.ELPIDA_X_REDIRECT_URI,fetcher=fetch}={}){Object.assign(this,{clientId,clientSecret,redirectUri,fetcher});this.sessions=new Map();}
 get enabled(){return !!(this.clientId&&this.redirectUri);}
 begin(claim){
  if(!this.enabled)throw new Error('Configure the X OAuth client ID and callback URL first. Fees remain in escrow.');
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),cookie=randomBytes(32).toString('base64url');
  this.sessions.set(state,{claim,verifier,cookie,expires:Date.now()+600000});
  const url=new URL('https://x.com/i/oauth2/authorize');url.search=new URLSearchParams({response_type:'code',client_id:this.clientId,redirect_uri:this.redirectUri,scope:'tweet.read users.read',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  return {url:url.href,cookie};
 }
 async complete({state,code,cookie}){
  const session=this.sessions.get(state);
  if(!session||session.expires<Date.now()||!cookie||cookie!==session.cookie)throw new Error('Invalid or expired X authentication session.');
  this.sessions.delete(state);
  if(!code)throw new Error('X authentication was cancelled.');
  const headers={'content-type':'application/x-www-form-urlencoded'};
  if(this.clientSecret)headers.authorization='Basic '+Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  const response=await this.fetcher('https://api.x.com/2/oauth2/token',{method:'POST',headers,body:new URLSearchParams({code,grant_type:'authorization_code',client_id:this.clientId,redirect_uri:this.redirectUri,code_verifier:session.verifier}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('X could not authorize this account. Check the app credentials and callback URL.');
  const token=await response.json();if(!token.access_token)throw new Error('X did not provide account authorization.');
  const userResponse=await this.fetcher('https://api.x.com/2/users/me',{headers:{authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(15000)});
  if(!userResponse.ok)throw new Error('X account lookup failed. Check the app access permissions.');
  const user=(await userResponse.json()).data;
  if(!user?.id||String(user.username).toLowerCase()!==session.claim.target)throw new Error('Sign in to the X profile named in this reward allocation.');
  return {...session.claim,xUserId:user.id};
 }
}
