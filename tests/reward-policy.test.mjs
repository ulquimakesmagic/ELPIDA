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

test('GitHub allocations: an account or a repository, on EVM public networks only (25 Nov 2026)', () => {
  const policy = (target, chain = 'base-mainnet') => normalizeRewardPolicy({ mode: 'exclusive', threshold: '1', minimumHolding: '0', vestingDays: 30, recipients: [{ kind: 'wallet', target: '', percent: 50 }, { kind: 'github', target, percent: 50 }] }, chain);
  assert.equal(policy('https://github.com/Elpida-Labs/Launchpad.git/').recipients[1].target, 'elpida-labs/launchpad');
  assert.equal(policy('Elpida-Dev').recipients[1].target, 'elpida-dev');
  for (const bad of ['-bad', 'a/b/c', 'owner/..', 'bad_owner', '']) assert.throws(() => policy(bad), /GitHub account/, bad);
  assert.throws(() => policy('elpida', 'local'), /EVM launchpads/);
  assert.throws(() => policy('elpida', 'solana-mainnet'), /EVM launchpads/);
});
