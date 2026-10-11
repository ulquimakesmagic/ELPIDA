import test from 'node:test';
import assert from 'node:assert/strict';
import {launchProfile,publishForLaunch} from '../apps/web/launch-capabilities.mjs';
test('all EVM preview chains offer native and USDC pairs without requiring public metadata',()=>{
 for(const chain of ['local','base-sepolia','ethereum-sepolia','bnb-testnet','robinhood-testnet']){
   assert.deepEqual(launchProfile(chain).pairs,['native','usdc']);assert.equal(launchProfile(chain).decimals,18);
   assert.equal(publishForLaunch({chain,publicEnabled:false,metadataSupported:true}),false);
 }
});
test('Solana preview exposes only the pair and decimals implemented by its program',()=>{
 assert.deepEqual(launchProfile('solana-devnet'),{solana:true,pairs:['usdc'],decimals:6,maxNameBytes:32});
 assert.equal(publishForLaunch({chain:'solana-devnet',publicEnabled:true,metadataSupported:true}),false);
});
test('shared publishing is selected only when a compatible Base factory and provider are available',()=>{
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:true}),true);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:false}),false);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:false,metadataSupported:true}),false);
});
