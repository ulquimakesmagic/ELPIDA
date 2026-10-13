import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFundingError} from '../apps/web/payment-errors.mjs';
const context={native:'ETH',network:'Base Sepolia',feeInUsdc:true};
test('zero native funds with USDC payment identifies gas, not a zero native creation fee',()=>{
 const message=nativeFundingError({...context,balance:0n});
 assert.match(message,/no ETH on Base Sepolia for network gas/);
 assert.match(message,/launch fee is paid in USDC/);
 assert.doesNotMatch(message,/0\.0 ETH|creation fee/);
});
test('approval and launch shortages are separate and round the missing amount upwards',()=>{
 const approval=nativeFundingError({...context,balance:100n,gasCost:1_000_000_101n,stage:'approval'});
 assert.match(approval,/0\.000000002 more ETH/);
 assert.match(approval,/token approval network fee/);
 const launch=nativeFundingError({...context,balance:10_000_000_000n,gasCost:30_000_000_000n});
 assert.match(launch,/0\.00000002 more ETH/);
 assert.match(launch,/launch network fee/);
 assert.equal(nativeFundingError({...context,balance:30_000_000_000n,gasCost:30_000_000_000n}),null);
});
