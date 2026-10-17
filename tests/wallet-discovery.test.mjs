import test from 'node:test';
import assert from 'node:assert/strict';
import {injectedEvmWallets,injectedSolanaWallets,browserWalletCatalog,walletIcon,registerStandard,standardSolanaWallets,standardSolanaProvider} from '../apps/web/wallet-discovery.mjs';
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

test('common EVM namespaces retain their own names and logos even when they mimic MetaMask',()=>{
 let calls=0;
 const provider=flags=>({request(){calls++;},isMetaMask:true,...flags});
 const trust=provider({isTrust:true}),zerion=provider({isZerion:true}),phantom=provider({isPhantom:true}),rabby=provider({isRabby:true}),backpack=provider({isBackpack:true}),coinbase=provider({isCoinbaseWallet:true});
 const list=injectedEvmWallets({trustwallet:{ethereum:trust},zerion:{ethereum:zerion},phantom:{ethereum:phantom},rabby,backpack:{ethereum:backpack},coinbaseWalletExtension:coinbase,ethereum:{request(){calls++;},providers:[trust,zerion,phantom,rabby,backpack,coinbase]}});
 assert.deepEqual(list.map(w=>w.name),['Rabby','Zerion','Coinbase Wallet','Trust Wallet','Phantom','Backpack']);
 assert.equal(list.length,6);
 for(const wallet of list)assert.match(wallet.icon,/^\/assets\/wallets\/.+\.svg$/);
 assert.equal(calls,0,'discovery must not prompt any wallet');
});

test('unknown EIP-6963 wallets work without an allowlist and remote icons are not fetched',()=>{
 const provider={request(){throw new Error('Must not prompt');}};
 const [entry]=injectedEvmWallets({},[{info:{rdns:'app.newwallet',name:'New wallet',icon:'https://untrusted.example/icon.svg'},provider}]);
 assert.equal(entry.provider,provider);assert.equal(entry.name,'New wallet');assert.equal(entry.icon,'');
 assert.deepEqual(injectedEvmWallets({},[null,{info:{rdns:'bad',name:'Bad'},provider:{request:true}}]),[]);
});

test('Solana discovery requires signing support, deduplicates aliases and keeps EVM providers separate',()=>{
 const sol={connect(){throw new Error('Must not connect');},signTransaction(){},isPhantom:true},evm={request(){}};
 const trust={connect(){},signTransaction(){}};
 const list=injectedSolanaWallets({phantom:{ethereum:evm,solana:sol},solana:sol,trustwallet:{ethereum:evm,solana:trust},backpack:{ethereum:evm},okxwallet:{solana:{connect(){}}}});
 assert.deepEqual(list.map(w=>w.name),['Phantom','Trust Wallet']);
 assert.equal(list[0].provider,sol);assert.equal(list[1].provider,trust);
 assert.ok(list.every(w=>w.provider!==evm));
});

test('all catalog wallets have bundled SVG icons and official HTTPS install links',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const wallet of browserWalletCatalog){
  assert.equal(new URL(wallet.url).protocol,'https:');
  const asset=walletIcon(wallet.name);assert.ok(asset,wallet.name+' icon');
  assert.match(await readFile(new URL('../apps/web'+asset,import.meta.url),'utf8'),/<svg/);
 }
 assert.equal(walletIcon('Trust Wallet','javascript:alert(1)'),'/assets/wallets/trust.svg');
 assert.equal(walletIcon('Unknown','data:text/html,<script>'), '');
});

test('Solana standard message signing binds the selected account and exact message bytes',async()=>{
 const account={address:'chat-account',publicKey:[1],chains:['solana:devnet'],features:['solana:signTransaction','solana:signMessage']};let input,modified=false;
 const wallet={name:'Chat signing wallet',chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction(){}},'solana:signMessage':{signMessage:async i=>{input=i;return [{signature:new Uint8Array(64),signedMessage:modified?new Uint8Array([9]):i.message}];}}}};
 const remove=registerStandard(wallet);try{
  const p=standardSolanaProvider('standard:'+wallet.name,{PublicKey:class{} });await p.connect();
  const message=new Uint8Array([1,2,3]);assert.equal((await p.signMessage(message)).signature.length,64);assert.equal(input.account,account);assert.equal(input.message,message);
  modified=true;await assert.rejects(p.signMessage(message),/exact requested message/);
  wallet.accounts=[];await assert.rejects(p.signMessage(message),/account changed/);
 }finally{remove();}
});
