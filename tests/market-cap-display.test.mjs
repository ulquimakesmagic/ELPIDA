import test from 'node:test';
import assert from 'node:assert/strict';
import {fmtMarketCap} from '../apps/web/ui.mjs';
test('market cap uses dollars and never falls back to pair units',()=>{
 const t={spotPrice:2,supply:1000,quoteSymbol:'tNVDAon'};
 assert.equal(fmtMarketCap(t),'USD unavailable');
 assert.equal(fmtMarketCap({...t,usdReference:{status:'fresh',usd:180,updatedAt:Math.floor(Date.now()/1000),maxAge:180}}),'$360K');
 assert.equal(fmtMarketCap(t,123),'USD unavailable');
 assert.equal(fmtMarketCap({...t,usdReference:{status:'stale',usd:180,updatedAt:0}}),'USD unavailable');
});
