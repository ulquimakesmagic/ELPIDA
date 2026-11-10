import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteNativePairConversion} from '../apps/web/usdc-conversion.mjs';
const addr=n=>'0x'+String(n).padStart(40,'0');
function fixture({mismatch=false,empty=false}={}){
 const dex={router:addr(1),quoter:addr(2),factory:addr(3),weth:addr(4)},asset=addr(5),seen=[];
 class Contract {constructor(a){
  if(a===dex.router||a===dex.quoter)return {factory:async()=>mismatch?addr(99):dex.factory,WETH9:async()=>dex.weth,quoteExactInputSingle:{staticCall:async q=>{seen.push(q);return [q.fee===500?200n:100n];}}};
  if(a===dex.factory)return {getPool:async(a,b,fee)=>!empty&&[500,3000].includes(fee)?addr(fee):addr(0)};
  return {token0:async()=>asset,token1:async()=>dex.weth,factory:async()=>dex.factory,fee:async()=>Number(a.slice(-4)),liquidity:async()=>100n};
 }}
 return {Contract,dex,asset,seen};
}
test('native conversion quotes both directions, chooses best executable pool and bounds output',async()=>{
 const f=fixture();const q=await quoteNativePairConversion({...f,amountIn:1000n});
 assert.equal(q.fee,500);assert.equal(q.minimum,198n);assert.equal(q.tokenIn,f.dex.weth);assert.equal(q.tokenOut,f.asset);
 const r=await quoteNativePairConversion({...f,amountIn:1000n,toNative:true});assert.equal(r.tokenOut,f.dex.weth);assert.equal(r.tokenIn,f.asset);
});
test('missing liquidity, untrusted routing and invalid budgets cannot quote',async()=>{
 await assert.rejects(quoteNativePairConversion({...fixture({empty:true}),amountIn:1n}),/No funded/);
 await assert.rejects(quoteNativePairConversion({...fixture({mismatch:true}),amountIn:1n}),/do not match/);
 for(const args of [{amountIn:0n},{amountIn:1n,slippageBps:501},{amountIn:1n,slippageBps:0}])await assert.rejects(quoteNativePairConversion({...fixture(),...args}),/Invalid/);
});

test('real V3 liquidity converts native to a pair asset and cashes it back out with bounded minimums',async t=>{
 const {Contract,Interface,parseEther}=await import('ethers');
 const {dexFixture,mined}=await import('./helpers/dex-fixture.mjs');
 const {swapCalldata}=await import('../packages/core/dex-router.mjs');
 const f=await dexFixture(t),signer=f.signers[0],owner=f.addresses[0],d=f.dex;
 const amount=parseEther('2');await mined(d.weth.connect(signer).deposit({value:amount}));await mined(f.usdc.mint(owner,amount));
 for(const coin of [d.weth,f.usdc])await mined(coin.connect(signer).approve(d.manager.target,amount));
 const [token0,token1]=[d.weth.target,f.usdc.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 await mined(d.manager.createAndInitializePoolIfNecessary(token0,token1,10000,2n**96n));
 const deadline=BigInt(await f.now()+300);
 await mined(d.manager.mint({token0,token1,fee:10000,tickLower:-887200,tickUpper:887200,amount0Desired:amount,amount1Desired:amount,amount0Min:0,amount1Min:0,recipient:owner,deadline}));
 const q=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:parseEther('.01')});
 const before=await f.usdc.balanceOf(owner);
 const data=swapCalldata(Interface,2,d.router.target,{tokenIn:q.tokenIn,tokenOut:q.tokenOut,fee:q.fee,recipient:owner,amountIn:q.amountIn,amountOutMinimum:q.minimum},{deadline,refundETH:true});
 await mined(signer.sendTransaction({to:d.router.target,data,value:q.amountIn}));
 const received=await f.usdc.balanceOf(owner)-before;assert.ok(received>=q.minimum);
 const reverse=await quoteNativePairConversion({Contract,provider:f.provider,dex:d.config,asset:f.usdc.target,amountIn:received,toNative:true});
 await mined(f.usdc.connect(signer).approve(d.router.target,received));
 const back=swapCalldata(Interface,2,d.router.target,{tokenIn:reverse.tokenIn,tokenOut:reverse.tokenOut,fee:reverse.fee,recipient:owner,amountIn:received,amountOutMinimum:reverse.minimum},{deadline,unwrapTo:owner});
 const nativeBefore=await f.provider.getBalance(owner);
 const receipt=await mined(signer.sendTransaction({to:d.router.target,data:back}));
 assert.ok(await f.provider.getBalance(owner)+receipt.gasUsed*receipt.gasPrice>=nativeBefore+reverse.minimum);
 assert.equal(await f.usdc.allowance(owner,d.router.target),0n);
 // Execute the browser's actual atomic composition from a smart wallet, then force a late failure.
 await import('./helpers/browser-modules.mjs');
 const {TestnetWallet}=await import('../apps/web/wallet.mjs');
 const {launch}=await import('./helpers/dex-fixture.mjs');
 const {ContractFactory}=await import('ethers');const solc=(await import('solc')).default;
 const source='pragma solidity ^0.8.24; contract Account {address immutable owner;constructor(){owner=msg.sender;}receive()external payable{} function execute(address[] calldata t,bytes[] calldata d,uint256[] calldata v)external{require(msg.sender==owner);for(uint i;i<t.length;i++){(bool ok,)=t[i].call{value:v[i]}(d[i]);require(ok,"batch failed");}}}';
 const artifact=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'A.sol':{content:source}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['A.sol'].Account;
 const account=await new ContractFactory(artifact.abi,artifact.evm.bytecode.object,signer).deploy();await account.waitForDeployment();await mined(signer.sendTransaction({to:account.target,value:parseEther('.1')}));
 const l=await launch(f,{native:false,firstBuy:0n});await f.advance(61);
 const wallet=Object.create(TestnetWallet.prototype),item={address:l.token.target,curve:l.curve.target,pair:'usdc',quoteAddress:f.usdc.target,quoteDecimals:6,symbol:'HOPE'};
 Object.assign(wallet,{provider:f.provider,address:account.target,net:{chainId:31337},launches:new Map([[item.address.toLowerCase(),item]]),checkNetwork:async()=>{},verifyFactory:async()=>f.factory,canBatch:async()=>true,stockPreflight:async()=>{}});
 Object.defineProperties(wallet,{dex:{value:d.config},artifacts:{value:{curve:{abi:l.curve.interface.fragments}}}});
 let fail=false;
 wallet.sendCalls=async(calls,message,options)=>{assert.equal(options.atomicRequired,true);const txs=fail?[...calls,{to:account.target,data:'0xdeadbeef'}]:calls;const receipt=await mined(account.execute(txs.map(c=>c.to),txs.map(c=>c.data),txs.map(c=>c.value??0n)));return {tx:{hash:receipt.hash},receipt};};
 let atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});
 await wallet.tradeNativePair(atomicQuote);assert.ok(await l.token.balanceOf(account.target)>0n);assert.equal(await f.usdc.allowance(account.target,l.curve.target),0n);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'sell',amount:'1000000'});await wallet.tradeNativePair(atomicQuote);
 assert.equal(await l.token.allowance(account.target,l.curve.target),0n);assert.equal(await f.usdc.allowance(account.target,d.router.target),0n);
 const beforeTokens=await l.token.balanceOf(account.target),beforeQuote=await f.usdc.balanceOf(account.target),beforeNative=await f.provider.getBalance(account.target);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});fail=true;await assert.rejects(wallet.tradeNativePair(atomicQuote),/batch failed/);
 assert.equal(await l.token.balanceOf(account.target),beforeTokens);assert.equal(await f.usdc.balanceOf(account.target),beforeQuote);assert.equal(await f.provider.getBalance(account.target),beforeNative);
 fail=false;const {complete}=await import('./helpers/dex-fixture.mjs');await complete(f,l);await mined(l.curve.graduate());
 wallet.config={contracts:{quoter:{abi:d.quoter.interface.fragments},pool:{abi:[]}}};
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'buy',amount:'0.0000000001'});await wallet.tradeNativePair(atomicQuote);
 atomicQuote=await wallet.getNativePairTradeQuote({token:item.address,side:'sell',amount:'1000000'});await wallet.tradeNativePair(atomicQuote);
 assert.notEqual(await l.curve.pool(),'0x0000000000000000000000000000000000000000');
 const unsupported=Object.create(TestnetWallet.prototype);unsupported.canBatch=async()=>false;
 await assert.rejects(unsupported.sendCalls([{to:owner,data:'0x'},{to:owner,data:'0x'}],'test',{atomicRequired:true}),/no transactions were submitted/);

});

// ELPIDA V2 tokens paired with an ERC-20: paying and receiving the native coin goes through the network's conversion
// pool (real Uniswap v3 here), then the token's V2 router. The router below is a stand-in with the V2 router's exact
// functions (quote, buy, sell), so the test checks the browser's composition: amounts, approvals and minimums.
test('V2 pair-asset token: buy with the native coin and sell back to it through the conversion pool and the V2 router', async t => {
  const { ContractFactory, parseEther, formatEther } = await import('ethers');
  const { dexFixture, mined } = await import('./helpers/dex-fixture.mjs');
  await import('./helpers/browser-modules.mjs');
  const { TestnetWallet } = await import('../apps/web/wallet.mjs');
  const solc = (await import('solc')).default;
  const f = await dexFixture(t), signer = f.signers[0], owner = f.addresses[0], d = f.dex;
  const amount = parseEther('2'); await mined(d.weth.connect(signer).deposit({ value: amount })); await mined(f.usdc.mint(owner, amount));
  for (const coin of [d.weth, f.usdc]) await mined(coin.connect(signer).approve(d.manager.target, amount));
  const [token0, token1] = [d.weth.target, f.usdc.target].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  await mined(d.manager.createAndInitializePoolIfNecessary(token0, token1, 10000, 2n ** 96n));
  await mined(d.manager.mint({ token0, token1, fee: 10000, tickLower: -887200, tickUpper: 887200, amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0, recipient: owner, deadline: BigInt(await f.now() + 300) }));
  const source = `pragma solidity ^0.8.24;
    contract Coin { mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
      function mint(address to,uint256 v) external { balanceOf[to]+=v; }
      function approve(address s,uint256 v) external returns(bool){ allowance[msg.sender][s]=v; return true; }
      function transfer(address to,uint256 v) external returns(bool){ balanceOf[msg.sender]-=v; balanceOf[to]+=v; return true; }
      function transferFrom(address a,address to,uint256 v) external returns(bool){ allowance[a][msg.sender]-=v; balanceOf[a]-=v; balanceOf[to]+=v; return true; } }
    interface IERC20 { function transferFrom(address,address,uint256) external returns(bool); function transfer(address,uint256) external returns(bool); }
    contract Router { address immutable quoteAsset; address immutable launched; constructor(address q,address l){ quoteAsset=q; launched=l; }
      function quote(address,bool isBuy,uint256 amountIn) external pure returns(uint256,uint256){ return (amountIn, isBuy ? amountIn*1000 : amountIn/1000); }
      function buy(address,uint256 quoteIn,uint256 minOut,address to,uint256) external payable returns(uint256 out){ IERC20(quoteAsset).transferFrom(msg.sender,address(this),quoteIn); out=quoteIn*1000; require(out>=minOut,"min"); IERC20(launched).transfer(to,out); }
      function sell(address,uint256 tokensIn,uint256 minOut,address to,uint256) external returns(uint256 out){ IERC20(launched).transferFrom(msg.sender,address(this),tokensIn); out=tokensIn/1000; require(out>=minOut,"min"); IERC20(quoteAsset).transfer(to,out); } }`;
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'R.sol': { content: source } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }))).contracts['R.sol'];
  const coin = await new ContractFactory(out.Coin.abi, out.Coin.evm.bytecode.object, signer).deploy(); await coin.waitForDeployment();
  const router = await new ContractFactory(out.Router.abi, out.Router.evm.bytecode.object, signer).deploy(f.usdc.target, coin.target); await router.waitForDeployment();
  await mined(coin.mint(router.target, parseEther('1000000000'))); await mined(f.usdc.mint(router.target, parseEther('1')));
  const item = { address: coin.target, pair: 'usdc', quoteAddress: f.usdc.target, quoteDecimals: 6, quoteSymbol: 'USDC', symbol: 'HOPE', deploymentModel: 'v2-hook' };
  const net = { key: 'base-sepolia', name: 'Local', chainId: 31337, nativeCurrency: { symbol: 'ETH' }, v4: { poolManager: f.addresses[3] }, v2: { shared: { factory: f.addresses[3], hook: f.addresses[3], router: router.target } } };
  const wallet = Object.create(TestnetWallet.prototype), steps = [];
  Object.assign(wallet, { provider: f.provider, signer, address: owner, net, launches: new Map([[item.address.toLowerCase(), item]]), checkNetwork: async () => {}, stockPreflight: async () => {}, onProgress: () => {},
    verifyFactory: async () => { throw new Error('the Model 10 factory is not used for V2'); },
    sendCalls: async calls => { let last; for (const c of calls) { steps.push(c.label); const tx = await signer.sendTransaction({ to: c.to, data: c.data, value: c.value ?? 0n }); last = { tx, receipt: await tx.wait() }; } return last; } });
  Object.defineProperty(wallet, 'dex', { value: d.config });

  const buyQuote = await wallet.getNativePairTradeQuote({ token: coin.target, side: 'buy', amount: '0.01' });
  assert.equal(buyQuote.execution, 'v4');
  assert.ok(BigInt(buyQuote.pairAmount) > 0n && BigInt(buyQuote.minimum) === BigInt(buyQuote.pairAmount) * 1000n * 9900n / 10000n);
  const usdcBefore = await f.usdc.balanceOf(owner);
  await wallet.transact('trade-native-pair', buyQuote); // through the token page's action, as the Buy button does
  assert.deepEqual(steps, ['Convert ETH to USDC…', 'Approve USDC for this buy…', 'Buy HOPE…']);
  const bought = await coin.balanceOf(owner);
  assert.equal(bought, BigInt(buyQuote.pairAmount) * 1000n, 'buys with the conversion\'s guaranteed USDC');
  assert.ok(await f.usdc.balanceOf(owner) >= usdcBefore, 'any extra USDC from the conversion stays in the wallet');
  assert.equal(await f.usdc.allowance(owner, router.target), 0n, 'the exact approval is used up');

  steps.length = 0;
  const sellQuote = await wallet.getNativePairTradeQuote({ token: coin.target, side: 'sell', amount: formatEther(bought) });
  const ethBefore = await f.provider.getBalance(owner);
  await wallet.tradeNativePair(sellQuote);
  assert.deepEqual(steps, ['Approve HOPE for this sale…', 'Sell HOPE…', 'Approve USDC for the conversion…', 'Convert USDC to ETH…']);
  assert.equal(await coin.balanceOf(owner), 0n);
  assert.ok(await f.provider.getBalance(owner) > ethBefore - parseEther('0.005'), 'ETH came back (less gas)');
  await assert.rejects(wallet.tradeNativePair({ ...buyQuote, quotedAt: Date.now() - 120_000 }), /expired/);
  // A pair asset without a conversion pool (here: the launched token itself as a stand-in asset) names the exact asset.
  const other = { ...item, address: f.usdc.target, quoteAddress: coin.target, quoteSymbol: 'tNVDAon' };
  wallet.launches.set(other.address.toLowerCase(), other);
  await assert.rejects(wallet.getNativePairTradeQuote({ token: other.address, side: 'buy', amount: '0.01' }), new RegExp(`no funded ETH/tNVDAon conversion pool for this tNVDAon \\(${coin.target.slice(0, 6)}…${coin.target.slice(-4)}\\)`));
});
