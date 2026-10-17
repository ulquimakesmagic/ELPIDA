import test from 'node:test';
import assert from 'node:assert/strict';
import {startRehearsalServer} from '../apps/api/holder-rehearsal-server.mjs';

test('local browser rehearsal runs real Model 10 fees, historical funding and restart-safe payouts',async t=>{
 const app=await startRehearsalServer();t.after(()=>app.close());
 const initial=await (await fetch(app.url+'/api/state')).json();assert.equal(initial.phase,'empty');
 assert.equal((await fetch(app.url+'/')).status,200);
 const act=async action=>{
  const response=await fetch(app.url+'/api/action',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Rehearsal-Token':initial.csrf},body:JSON.stringify({action})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
 };
 const bad=await fetch(app.url+'/api/action',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({action:'setup'})});assert.equal(bad.status,403);
 let result;
 for(const action of ['setup','trade','sync','snapshot','fund','advance','pay','pay','retry'])result=await act(action);
 assert.equal(result.phase,'complete');assert.equal(result.balances.paid,'0.275');assert.equal(result.balances.accounted,'0.1');assert.equal(result.balances.reserved,'0.0');assert.equal(result.balances.protectedClaims,'100.0');
 assert.ok(Object.values(result.checks).every(Boolean));assert.equal(result.holders.length,3);assert.ok(result.holders.every(h=>h.paid&&h.entitlement===h.received));
 const replay=await act('retry');assert.equal(replay.balances.paid,'0.275');
 const rejected=await fetch(app.url+'/api/action',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Rehearsal-Token':initial.csrf},body:JSON.stringify({action:'trade',rpcUrl:'https://evil.example'})});assert.equal(rejected.status,400);
});
