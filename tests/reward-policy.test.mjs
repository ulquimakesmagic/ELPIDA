import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRewardPolicy,holderDistribution} from '../apps/web/reward-policy.mjs';
test('allocations normalize identities and reject over-allocation and duplicate recipients',()=>{
 const p=normalizeRewardPolicy({mode:'exclusive',recipients:[{kind:'x',target:'https://x.com/Community',percent:25},{kind:'domain',target:'https://community.org/',percent:75}]});
 assert.equal(p.recipients[0].target,'community');assert.deepEqual(normalizeRewardPolicy(p),p);
 assert.throws(()=>normalizeRewardPolicy({recipients:[{kind:'wallet',target:'',percent:99}]}),/100%/);
 assert.throws(()=>normalizeRewardPolicy({mode:'exclusive',recipients:[{kind:'x',target:'@abc',percent:50},{kind:'x',target:'abc',percent:50}]}),/only once/);
 assert.throws(()=>normalizeRewardPolicy({mode:'paired',rewardToken:'javascript:bad'}),/approved/);
 assert.throws(()=>normalizeRewardPolicy({mode:'holders',threshold:'0'}),/positive/);
});
test('holder epochs conserve funds, exclude pools and minimums, and weight eligible holdings',()=>{
 const result=holderDistribution(101n,[{address:'a',balance:100n},{address:'b',balance:200n},{address:'c',balance:1n},{address:'pool',balance:10000n}],10n,['pool']);
 assert.deepEqual(result.sort((a,b)=>a.address.localeCompare(b.address)),[{address:'a',amount:34n},{address:'b',amount:67n}]);
 assert.equal(holderDistribution(100n,[{address:'a',balance:1n}],2n).length,0);
 assert.equal(holderDistribution(2n,[{address:'a',balance:1n},{address:'a',balance:1n},{address:'b',balance:1n}],0n).reduce((n,r)=>n+r.amount,0n),2n);
});
