import test from 'node:test';
import assert from 'node:assert/strict';
import {fmtMarketCap,fmtPrice,fmtValue} from '../apps/web/ui.mjs';
// 6 November 2026 (Malik): market cap, liquidity and price are only ever shown in dollars, never in the pair asset.
test('market cap, price and liquidity are in dollars only; a pair asset with no dollar reference shows a dash',()=>{
 const t={spotPrice:2,supply:1000,quoteSymbol:'tNVDAon'};
 for(const shown of [fmtMarketCap(t),fmtMarketCap(t,123),fmtPrice(t),fmtValue(5,t)])assert.equal(shown,'—');
 const ref={status:'fresh',usd:180,updatedAt:Math.floor(Date.now()/1000),maxAge:180};
 assert.equal(fmtMarketCap({...t,usdReference:ref}),'$360K');
 assert.equal(fmtValue(5,{...t,usdReference:ref}),'$900');
 assert.match(fmtPrice({...t,usdReference:ref}),/^\$/);
 // A stale or old reference still values them: a missed refresh never turns dollars into the pair asset.
 assert.equal(fmtMarketCap({...t,usdReference:{...ref,status:'stale',updatedAt:0}}),'$360K');
 for(const shown of [fmtMarketCap(t),fmtPrice(t),fmtValue(1,t)])assert.ok(!shown.includes('tNVDAon'));
});
