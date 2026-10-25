// The JSON routes that await a chain sync per request must be bounded, or one client can force unbounded RPC work
// (audit finding B2). The window is 240 requests a minute across those routes, so a page that polls every 60 s is
// unaffected while a loop is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../apps/api/server.mjs';

test('the sync routes refuse a client that would otherwise force unbounded chain syncs',async t=>{
  const app=await startServer({port:0,seed:false});
  t.after(()=>app.close());

  let refusal=null;
  for(let call=1;call<=260&&!refusal;call++){
    const response=await fetch(`${app.url}/api/indexer/status`);
    if(response.status===429){refusal={at:call,body:await response.json()};break;}
    assert.equal(response.status,200,`call ${call} returned ${response.status}`);
  }

  assert.ok(refusal,'260 calls and nothing was refused: the route is unbounded');
  assert.equal(refusal.at,241,'the 240-request window closes on the 241st call');
  assert.match(refusal.body.error,/busy/i);

  // The other guarded routes share the same window, so they are refused too until it reopens.
  const other=await fetch(`${app.url}/api/tokens`);
  assert.equal(other.status,429);
});
