import test from 'node:test';
import assert from 'node:assert/strict';
import {compactTradeAmount} from '../apps/web/amounts.mjs';
test('compact quote display stays short without erasing small positive amounts',()=>{
 assert.equal(compactTradeAmount('47274250.493686792929136544'),'47.27M');
 assert.equal(compactTradeAmount('0.000000000000000001'),'1e-18');
 assert.equal(compactTradeAmount('0.123456789'),'0.123457');
 assert.equal(compactTradeAmount('0'),'0');assert.equal(compactTradeAmount('bad'),'—');
});
