import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../apps/api/server.mjs';

test('public wallet metadata has narrow read-only CORS and never exports an unready index',async t=>{
 const app=await startServer({port:0,seed:false,publicUrl:'https://elpida.example'});t.after(()=>app.close());
 const headers={Origin:'https://wallet.example'};
 const response=await fetch(app.url+'/api/wallet-tokenlist.json',{headers});
 assert.equal(response.status,503);assert.equal(response.headers.get('access-control-allow-origin'),'*');
 assert.equal((await fetch(app.url+'/api/wallet-tokenlist.json?network=solana-devnet',{headers})).status,400);
 const missingLogo=await fetch(app.url+'/api/wallet-logo/base-sepolia/0x'+'11'.repeat(20),{headers});
 assert.equal(missingLogo.status,404);assert.equal(missingLogo.headers.get('access-control-allow-origin'),'*');
 assert.equal((await fetch(app.url+'/api/config',{headers})).status,403);
 assert.equal((await fetch(app.url+'/holder-rehearsal.html')).status,404,'rehearsal is not exposed by the application server');
 assert.equal((await fetch(app.url+'/wallet-token.mjs')).status,200);
 const config=await (await fetch(app.url+'/api/config')).json();
 const mutation=await fetch(app.url+'/api/metadata/publish',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Elpida-Token':config.csrf},body:'{}'});
 assert.equal(mutation.status,403);
});
