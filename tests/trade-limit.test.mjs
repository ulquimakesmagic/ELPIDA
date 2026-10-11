import test from 'node:test';
import assert from 'node:assert/strict';
import {exceedsRemaining} from '../apps/web/token-page.mjs';

test('curve limits preserve exact ETH and token decimal precision',()=>{
 const remaining='1.471012658227848101';
 assert.equal(exceedsRemaining('2',remaining),true);
 assert.equal(exceedsRemaining(remaining,remaining),false);
 assert.equal(exceedsRemaining('1.471012658227848102',remaining),true);
 assert.equal(exceedsRemaining('1.471012658227848100',remaining),false);
 assert.equal(exceedsRemaining('25.000001','25.000000'),true);
 assert.equal(exceedsRemaining('00025.0','25'),false);
 assert.equal(exceedsRemaining('0.001','1'),false);
});
