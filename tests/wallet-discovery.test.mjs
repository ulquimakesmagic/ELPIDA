import test from 'node:test';
import assert from 'node:assert/strict';
import {injectedEvmWallets,registerStandard,standardSolanaWallets,standardSolanaProvider} from '../apps/web/wallet-discovery.mjs';
test('announced and legacy EVM wallets are deduplicated without prompting',()=>{
 let calls=0;const a={request(){calls++;},isMetaMask:true},b={request(){calls++;},isRabby:true};
 const list=injectedEvmWallets({ethereum:{...a,providers:[a,b]},rabby:b},[{info:{rdns:'io.metamask',name:'MetaMask',icon:'data:image/png;base64,x'},provider:a}]);
 assert.equal(list.filter(w=>w.provider===a).length,1);assert.equal(list.filter(w=>w.provider===b).length,1);assert.equal(list[0].icon,'data:image/png;base64,x');assert.equal(calls,0);
});
test('Solana standard discovery filters the chain and required signing feature',()=>{
 const wallet={name:'Test extension',icon:'data:image/png;base64,x',chains:['solana:devnet'],features:{'standard:connect':{connect(){}},'solana:signTransaction':{signTransaction(){},supportedTransactionVersions:['legacy']}}};
 const remove=registerStandard(wallet);assert.ok(standardSolanaWallets().some(w=>w.name===wallet.name));assert.ok(!standardSolanaWallets('solana:mainnet').some(w=>w.name===wallet.name));remove();
});
test('only the chosen Solana adapter connects and it passes chain/account with serialized bytes',async()=>{
 const account={address:'address',publicKey:[1],chains:['solana:devnet'],features:['solana:signTransaction']};let connects=0,input;
 const wallet={name:'Signing extension',chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{async connect(){connects++;return{accounts:[account]};}},'solana:signTransaction':{supportedTransactionVersions:['legacy'],async signTransaction(i){input=i;return[{signedTransaction:new Uint8Array([2])}];}}}};
 const remove=registerStandard(wallet);const web3={PublicKey:class{constructor(bytes){this.bytes=bytes;}},Transaction:{from:b=>b}};
 assert.equal(standardSolanaProvider('missing',web3),null);const p=standardSolanaProvider('standard:'+wallet.name,web3);assert.equal(connects,0);await p.connect();await p.signTransaction({serialize:()=>new Uint8Array([1])});assert.equal(connects,1);assert.equal(input.chain,'solana:devnet');assert.equal(input.account,account);assert.deepEqual([...input.transaction],[1]);remove();
});
