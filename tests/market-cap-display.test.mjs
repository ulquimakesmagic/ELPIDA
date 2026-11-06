import test from 'node:test';
import assert from 'node:assert/strict';
import {fmtMarketCap} from '../apps/web/ui.mjs';
test('market cap is in dollars, and in the pair asset only when the asset has no dollar price at all',()=>{
 const t={spotPrice:2,supply:1000,quoteSymbol:'tNVDAon'};
 assert.equal(fmtMarketCap(t),'2K tNVDAon');
 assert.equal(fmtMarketCap({...t,usdReference:{status:'fresh',usd:180,updatedAt:Math.floor(Date.now()/1000),maxAge:180}}),'$360K');
 assert.equal(fmtMarketCap(t,123),'123 tNVDAon');
 // A missed refresh (stale, within the hour) still shows dollars; a reference older than that does not.
 assert.equal(fmtMarketCap({...t,usdReference:{status:'stale',usd:180,updatedAt:Math.floor(Date.now()/1000)-600,maxAge:180}}),'$360K');
 assert.equal(fmtMarketCap({...t,usdReference:{status:'stale',usd:180,updatedAt:0}}),'2K tNVDAon');
});
