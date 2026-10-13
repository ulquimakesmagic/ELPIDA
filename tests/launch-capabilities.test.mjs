import test from 'node:test';
import assert from 'node:assert/strict';
import {launchProfile,publishForLaunch} from '../apps/web/launch-capabilities.mjs';
test('every chain uses the same four trading-pair kinds without requiring public metadata',()=>{
 for(const chain of ['local','base-sepolia','ethereum-sepolia','bnb-testnet','robinhood-testnet']){
   assert.deepEqual(launchProfile(chain).pairs,['native','usdc','xstock','token']);assert.equal(launchProfile(chain).decimals,18);
   assert.equal(publishForLaunch({chain,publicEnabled:false,metadataSupported:true}),chain==='base-sepolia');
 }
});
test('Solana uses the same pair kinds with its own token decimals',()=>{
 assert.deepEqual(launchProfile('solana-devnet'),{solana:true,pairs:['native','usdc','xstock','token'],decimals:6,maxNameBytes:32});
 assert.equal(publishForLaunch({chain:'solana-devnet',publicEnabled:true,metadataSupported:true}),false);
});
test('a compatible Base launch always stages metadata in its launch transaction',()=>{
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:true}),true);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:false}),false);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:false,metadataSupported:true}),true);
});
