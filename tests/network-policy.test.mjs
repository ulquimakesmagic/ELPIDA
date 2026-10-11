import test from 'node:test';
import assert from 'node:assert/strict';
import { publicOrigin, acceptsRequest } from '../apps/api/network-policy.mjs';

test('public origins accept Railway and explicit HTTPS domains, rejecting unsafe values', () => {
  assert.equal(publicOrigin({}), null);
  assert.equal(publicOrigin({RAILWAY_PUBLIC_DOMAIN:'elpida.up.railway.app'}), 'https://elpida.up.railway.app');
  assert.equal(publicOrigin({ELPIDA_PUBLIC_URL:'https://elpida.example/'}), 'https://elpida.example');
  for (const value of ['http://elpida.example','https://user:pass@elpida.example','https://elpida.example/api','https://elpida.example/?x=1','https://elpida.example/#x']) assert.throws(() => publicOrigin({ELPIDA_PUBLIC_URL:value}));
});

test('only configured origins and the isolated Railway healthcheck host are admitted', () => {
  const request = {host:'elpida.up.railway.app',origin:'https://elpida.up.railway.app',method:'POST',path:'/api/launch',port:3000,publicUrl:'https://elpida.up.railway.app'};
  assert.equal(acceptsRequest(request), true);
  assert.equal(acceptsRequest({...request,origin:'https://foreign.example'}), false);
  assert.equal(acceptsRequest({...request,host:'foreign.up.railway.app'}), false);
  assert.equal(acceptsRequest({...request,host:'localhost:3000',origin:'http://localhost:3000'}), true);
  const health = {...request,host:'healthcheck.railway.app',origin:undefined,method:'GET',path:'/health'};
  assert.equal(acceptsRequest(health), true);
  assert.equal(acceptsRequest({...health,path:'/api/config'}), false);
  assert.equal(acceptsRequest({...health,method:'POST'}), false);
});
