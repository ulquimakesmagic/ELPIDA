import test from 'node:test';
import assert from 'node:assert/strict';
import {launchProfile,publishForLaunch} from '../apps/web/launch-capabilities.mjs';
test('every chain uses the same four trading-pair kinds without requiring public metadata',()=>{
 for(const chain of ['local','base-sepolia','ethereum-sepolia','bnb-testnet','robinhood-testnet']){
   assert.deepEqual(launchProfile(chain).pairs,['native','usdc','xstock','token']);assert.equal(launchProfile(chain).decimals,18);
   assert.equal(publishForLaunch({chain,publicEnabled:false,metadataSupported:true}),chain==='base-sepolia'||chain.startsWith('solana-'));
 }
});
test('Solana uses the same pair kinds with its own token decimals',()=>{
 assert.deepEqual(launchProfile('solana-devnet'),{solana:true,pairs:['native','usdc','xstock','token'],decimals:6,maxNameBytes:32});
 assert.equal(publishForLaunch({chain:'solana-devnet',publicEnabled:true,metadataSupported:true}),true,'Solana launches always write immutable Metaplex metadata');
 assert.equal(publishForLaunch({chain:'solana-mainnet',publicEnabled:false,metadataSupported:false}),true);
});
test('a compatible Base launch always stages metadata in its launch transaction',()=>{
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:true}),true);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:true,metadataSupported:false}),false);
 assert.equal(publishForLaunch({chain:'base-sepolia',publicEnabled:false,metadataSupported:true}),true);
});
test('other EVM chains stage details only on the publicly indexed team launchpad',()=>{
 assert.equal(publishForLaunch({chain:'ethereum-sepolia',publicEnabled:true,metadataSupported:true}),false,'a private per-browser launchpad would let staged details expire');
 assert.equal(publishForLaunch({chain:'ethereum-sepolia',publicEnabled:true,metadataSupported:true,publiclyIndexed:true}),true);
 assert.equal(publishForLaunch({chain:'ethereum-sepolia',publicEnabled:true,metadataSupported:false,publiclyIndexed:true}),false);
});
test('details always go into the launch transaction: a launchpad that cannot include them does not launch',async()=>{
 const {launchDetailsError}=await import('../apps/web/launch-capabilities.mjs');
 assert.equal(launchDetailsError({chain:'base-sepolia',networkName:'Base Sepolia',metadataSupported:true}),null);
 assert.equal(launchDetailsError({chain:'ethereum-sepolia',networkName:'Ethereum Sepolia',metadataSupported:true,publiclyIndexed:true}),null);
 assert.match(launchDetailsError({chain:'ethereum-sepolia',networkName:'Ethereum Sepolia',metadataSupported:true,publiclyIndexed:false}),/shared launchpad.*Nothing was submitted/);
 assert.match(launchDetailsError({chain:'bnb-testnet',networkName:'BNB Chain Testnet',metadataSupported:true}),/BNB Chain Testnet/);
 assert.match(launchDetailsError({chain:'base-sepolia',networkName:'Base Sepolia',metadataSupported:false}),/predates token details/);
 assert.equal(launchDetailsError({chain:'solana-devnet',networkName:'Solana Devnet',metadataSupported:true}),null);
});
