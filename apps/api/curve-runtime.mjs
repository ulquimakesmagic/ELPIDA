import { network } from 'hardhat';
import {RewardEngine} from './reward-engine.mjs';
import { BrowserProvider, Contract, ContractFactory, formatUnits, parseUnits, isAddress, ZeroAddress } from 'ethers';
import { compileContracts } from '../../scripts/compile.mjs';
import { testnets, evmTestnets } from '../../packages/core/networks.mjs';
import { amount } from './runtime.mjs';
import { EvmIndexer } from '../../packages/indexer/evm-indexer.mjs';
import {deployLocalV3,v3Artifacts,baseSepoliaDex} from '../../packages/core/uniswap.mjs';
import { normalizeMetadata } from '../web/metadata.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPricing, evmPricing } from '../../packages/core/pricing.mjs';
export async function createRuntime({seed = true, dex = false, metadataStore = null, metadataPath = null, indexerPath = ":memory:"} = {}) {
  const compiled = compileContracts({includeMocks:true});
  const artifact = name => compiled[`contracts/evm/src/${name}.sol`][name];
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1}); provider.pollingInterval = 10;
  const signers = await Promise.all([0,1,2,3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  // Generic ERC-20 ABI for paired assets (the mock is never deployed: pricing is native only).
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const pricing = loadPricing(), local = evmPricing('local',pricing);
  const v3=dex?await deployLocalV3(signers[0],compiled['tests/fixtures/LocalWrappedETH.sol'].LocalWrappedETH):null;
  let adapter;
  // Native pairs graduate through an adapter whose ERC-20 side is WETH; the native path wraps on migration.
  if(dex){const a=artifact('ElpidaV3MigrationAdapter');adapter=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(v3.manager.target,v3.weth.target,10000);await adapter.waitForDeployment();}
  const fa = artifact(dex?'ElpidaDexFactory':'ElpidaBetaFactory');
  const factory = await new ContractFactory(fa.abi,fa.evm.bytecode.object,signers[0]).deploy(addresses[2],local.launchFeeWei,local.virtualQuoteWei,...(dex?[adapter.target]:[])); await factory.waitForDeployment();
  const tokens = [], activity = [];
  const metadata = new Map(metadataPath && existsSync(metadataPath) ? Object.entries(JSON.parse(readFileSync(metadataPath,'utf8'))) : []);
  const listings = () => indexer.listings().map(r => ({...r,metadata:metadata.get(r.hash) ?? {}}));
  function saveMetadata(hash, value) {
    metadata.set(hash,value);
    if(metadataPath){mkdirSync(dirname(metadataPath),{recursive:true});writeFileSync(metadataPath+'.tmp',JSON.stringify(Object.fromEntries(metadata)));renameSync(metadataPath+'.tmp',metadataPath);}
  }
  const rewards = new RewardEngine({compiled,provider,executor:signers[3],verifier:signers[3],tokens,curveAbi:artifact(dex?'ElpidaDexCurve':'ElpidaBetaCurve').abi,tokenAbi:artifact('ElpidaToken').abi,dex:dex?{v3,lockerAbi:artifact('ElpidaV3FeeLocker').abi,splitterAbi:artifact('ElpidaFeeSplitter').abi}:null});
  await rewards.init();
  let queue = Promise.resolve();
  const config = {
    rewardAutomation:{localEnabled:true,publicEnabled:false},
    model:dex?'curve-dex-v7':'curve-beta-v6',dex:dex?v3.config:null,publicDex:baseSepoliaDex,pricing:pricing.evm,local:{chainId:31337,name:'Local devnet',nativeSymbol:'ETH',factory:await factory.getAddress(),treasury:addresses[2],launchFee:local.launchFee},
    accounts:addresses.slice(0,2).map((address,i) => ({id:String(i),address,name:i?'Trader':'Creator'})),testnets:evmTestnets,
    plannedTestnets:testnets.filter(n => !n.enabled).map(({key,name,note}) => ({key,name,note})),
    contracts:{...(dex?{dexPool:{abi:v3Artifacts.pool.abi},router:{abi:v3Artifacts.router.abi},quoter:{abi:v3Artifacts.quoter.abi},locker:{abi:artifact('ElpidaV3FeeLocker').abi},splitter:{abi:artifact('ElpidaFeeSplitter').abi}}:{}),dexFactory:{abi:artifact('ElpidaDexFactory').abi,bytecode:'0x'+artifact('ElpidaDexFactory').evm.bytecode.object},dexCurve:{abi:artifact('ElpidaDexCurve').abi},adapter:{abi:artifact('ElpidaV3MigrationAdapter').abi,bytecode:'0x'+artifact('ElpidaV3MigrationAdapter').evm.bytecode.object},legacyFactory:{abi:artifact('ElpidaBetaFactory').abi,bytecode:'0x'+artifact('ElpidaBetaFactory').evm.bytecode.object},legacyCurve:{abi:artifact('ElpidaBetaCurve').abi},factory:{abi:fa.abi,bytecode:`0x${fa.evm.bytecode.object}`},token:{abi:artifact('ElpidaToken').abi},curve:{abi:artifact(dex?'ElpidaDexCurve':'ElpidaBetaCurve').abi},pool:{abi:artifact('ElpidaLockedPool').abi},quote:{abi:mock.abi},testAsset:{abi:compiled['contracts/evm/testnet/ElpidaTestAsset.sol'].ElpidaTestAsset.abi,bytecode:'0x'+compiled['contracts/evm/testnet/ElpidaTestAsset.sol'].ElpidaTestAsset.evm.bytecode.object}},
  };
  const indexer = new EvmIndexer({provider,factory:await factory.getAddress(),contracts:config.contracts,path:indexerPath,fromBlock:(await factory.deploymentTransaction().wait()).blockNumber});
  const signerFor = account => { if (account !== '0' && account !== '1') throw new Error('Choose a local demo account.'); return signers[Number(account)]; };
  const recordFor = address => { const r = tokens.find(t => t.address.toLowerCase() === String(address).toLowerCase()); if (!r) throw new Error('Token not found.'); return r; };
  const original = (r, runner = provider) => new Contract(r.curve,config.contracts.curve.abi,runner);
  async function market(r,runner = provider) {
    const curve = original(r,runner), pool = await curve.pool();
    return pool === ZeroAddress ? curve : new Contract(pool,config.contracts.pool.abi,runner);
  }
  const mined = async p => { const tx = await p; await tx.wait(); return tx; };
  const decimals = r => r.pair === 'native' ? 18 : (r.quoteDecimals??6);
  const quoteFor = r => r.pair==='native'?null:new Contract(r.quoteAddress,config.contracts.quote.abi,provider);
  const bps = value => { const p = Number(value ?? '0.5'); if (!Number.isFinite(p) || p < 0.1 || p > 5) throw new Error('Slippage must be between 0.1% and 5%.'); return BigInt(Math.round(p*100)); };
  async function execute(action,body) {
    const s = signerFor(body.account ?? '0'), owner = await s.getAddress();
    if(action==='reward-stock-faucet'){const price=await rewards.stock.PRICE();const tx=await mined(rewards.stock.connect(s).buy(price,parseUnits('1',18),{value:price}));return {hash:tx.hash,message:`Received 1 simulated TEST-STOCK for ${formatUnits(price,18)} local ETH. This is not an issued xStock.`};}
    if (action === 'launch') {
      const details = normalizeMetadata(body);
      const name = String(body.name ?? '').trim(), symbol = String(body.symbol ?? '').trim().toUpperCase();
      if (!name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name and symbol.');
      const pair = body.pair ?? 'native'; if (!['native','token','xstock'].includes(pair)) throw new Error('Choose an approved trading pair.');
      const paired = pair==='token'||pair==='xstock';
      let pairAsset=ZeroAddress,pairDecimals=18,pairSymbol='ETH',pairVirtual;
      if(paired){
        if(!dex)throw new Error('xStock and paired-token launches need the DEX test environment.');
        const selectedAsset=rewards.assets().find(a=>a.address.toLowerCase()===String(body.quoteToken).toLowerCase());
        if(!selectedAsset||!selectedAsset.pairEligible)throw new Error('Choose a graduated ETH-paired Elpida token or the simulated stock.');
        if((pair==='xstock')!==(selectedAsset.kind==='simulation'))throw new Error(pair==='xstock'?'Choose the simulated stock for an xStock pair.':'Choose a graduated Elpida token for a paired-token launch.');
        pairAsset=selectedAsset.address;pairDecimals=18;pairSymbol=selectedAsset.symbol;
        const existing=await factory.approvedQuotes(pairAsset);
        if(existing.adapter===ZeroAddress){
          const a=artifact('ElpidaV3MigrationAdapter'),customAdapter=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[2]).deploy(v3.manager.target,pairAsset,10000);await customAdapter.waitForDeployment();
          // Same starting FDV as a native launch, expressed in the paired asset (price in ETH per unit).
          let price;if(selectedAsset.kind==='simulation')price=Number(formatUnits(await rewards.stock.PRICE(),18));else {price=Number(indexer.snapshot(pairAsset)?.spotPrice);}
          if(!Number.isFinite(price)||price<=0)throw new Error('The quote asset cannot be priced.');
          const quoteWhole=Number(local.startFdv)/price*Number(formatUnits(await factory.VIRTUAL_TOKEN(),18))/1e9;
          pairVirtual=parseUnits(quoteWhole.toFixed(12),18);await mined(factory.connect(signers[2]).approveQuote(pairAsset,pairVirtual,customAdapter.target));
        }else pairVirtual=existing.virtualQuote;
      }
      const buy = amount(body.firstBuy,pair === 'native' ? 18 : pairDecimals);
      const fee = await factory.launchFee();
      if(await provider.getBalance(owner)<fee+(pair==='native'?buy:0n))throw new Error('Not enough ETH for the creation fee and first buy.');
      if(paired&&await new Contract(pairAsset,config.contracts.quote.abi,provider).balanceOf(owner)<buy)throw new Error(`Not enough ${pairSymbol} for the first buy. Buy the paired token first, or use the simulated-stock test-funds button.`);
      const prepared = body.rewardPolicy ? await rewards.prepare(body.rewardPolicy,body.reward||owner,pair,pair==='native'?ZeroAddress:pairAsset) : null;
      const reward = prepared?.vault.target || body.reward || owner;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid reward wallet.');
      const v = paired?pairVirtual:await factory.nativeVirtualQuote();
      const net = buy - buy*125n/10000n, out = await factory.VIRTUAL_TOKEN()*net/(v+net);
      const published=dex&&metadataStore&&Object.values(details).some(Boolean)?await metadataStore.publish({name,symbol,...details}):null;
      if(paired)await mined(new Contract(pairAsset,config.contracts.quote.abi,s).approve(factory.target,buy));
      const args=[name,symbol,buy,out*9950n/10000n,reward];
      const tx = paired?(published?await factory.connect(s).launchPairedWithMetadata(name,symbol,pairAsset,buy,out*9950n/10000n,reward,published.uri,{value:fee}):await factory.connect(s).launchPaired(name,symbol,pairAsset,buy,out*9950n/10000n,reward,{value:fee})):published?await factory.connect(s).launchWithMetadata(...args,published.uri,{value:fee+buy}):await factory.connect(s).launch(...args,{value:fee+buy});
      const receipt = await tx.wait();
      const event = receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Launched');
      const r = {address:event.args.token.toLowerCase(),curve:event.args.curve,creator:owner,reward,name,symbol,pair,quoteAddress:pair==='native'?ZeroAddress:pairAsset,quoteSymbol:pair === 'native'?'ETH':pairSymbol,quoteDecimals:pair === 'native'?18:pairDecimals,created:Date.now(),hash:tx.hash};
      let metadataSaved = true;
      try { saveMetadata(tx.hash, published?.metadata??details); } catch { metadataSaved = false; }
      tokens.unshift(r); if(prepared)await rewards.attach(r,prepared,receipt.blockNumber); activity.unshift({type:'Launch',symbol,amount:formatUnits(buy,decimals(r)),quoteSymbol:r.quoteSymbol,account:owner,hash:tx.hash,time:Date.now()});
      return {hash:tx.hash,token:r.address,metadataSaved,message:`${symbol} launched on its ${r.quoteSymbol} virtual curve.${metadataSaved ? '' : ' Metadata saved for this session only; disk storage failed.'}`};
    }
    const r = recordFor(body.token), c = original(r,s), m = await market(r,s);
    let tx;
    if (action === 'graduate') {tx = await mined(c.graduate());r.graduated=true;}
    else if(dex && await c.pool()!==ZeroAddress && (action==='buy'||action==='sell'))tx=await dexTrade(r,s,owner,body,action);
    else if (action === 'withdraw') {
      tx = await mined(c.withdrawFees());
      if (await c.pool() !== ZeroAddress){if(dex){const locker=new Contract(await c.locker(),config.contracts.locker.abi,s);tx=await mined(locker.collectFees());const splitter=new Contract(await c.feeSplitter(),config.contracts.splitter.abi,s);for(const asset of [r.address,r.pair==='native'?v3.weth.target:r.quoteAddress])for(const recipient of [addresses[2],r.reward])tx=await mined(splitter.claim(asset,recipient));}else tx=await mined(m.withdrawFees());}
    } else if (action === 'buy' || action === 'sell') {
      const input = amount(body.amount,action === 'buy'?decimals(r):18);
      const [out] = action === 'buy' ? await m.quoteBuy(input) : await m.quoteSell(input);
      const min = out*(10000n-bps(body.slippage))/10000n;
      if (action === 'sell') {
        await mined(new Contract(r.address,config.contracts.token.abi,s).approve(await m.getAddress(),input));
        tx = await mined(m.sell(input,min));
      } else {
        if (r.pair !== 'native') await mined(quoteFor(r).connect(s).approve(await m.getAddress(),input));
        tx = await mined(m.buy(input,min,{value:r.pair === 'native'?input:0n}));
      }
    } else throw new Error('Unknown action.');
    activity.unshift({type:action === 'graduate'?'Graduation':action === 'withdraw'?'Fees paid':action === 'buy'?'Buy':'Sell',symbol:r.symbol,amount:body.amount ?? '',quoteSymbol:r.quoteSymbol,account:owner,hash:tx.hash,time:Date.now()}); activity.splice(100);
    return {hash:tx.hash,message:action === 'graduate'?dex?'Graduated into Uniswap v3 with permanently locked liquidity.':'Graduated into the locked test pool.':action === 'withdraw'?'Fees distributed to the fixed recipient wallets.':'Trade confirmed.'};
  }
  async function dexQuote(r,side,input){const quoteAsset=r.pair==='native'?v3.weth.target:r.quoteAddress;const result=await v3.quoter.quoteExactInputSingle.staticCall({tokenIn:side==='buy'?quoteAsset:r.address,tokenOut:side==='buy'?r.address:quoteAsset,amountIn:input,fee:10000,sqrtPriceLimitX96:0});return result[0];}
  async function dexTrade(r,s,owner,body,side){
    const input=amount(body.amount,side==='buy'?decimals(r):18),out=await dexQuote(r,side,input),minimum=out*(10000n-bps(body.slippage))/10000n,quoteAsset=r.pair==='native'?v3.weth.target:r.quoteAddress,router=v3.router.connect(s);
    const tokenIn=side==='buy'?quoteAsset:r.address,tokenOut=side==='buy'?r.address:quoteAsset;
    if(side==='sell'||r.pair!=='native')await mined(new Contract(tokenIn,config.contracts.quote.abi,s).approve(router.target,input));
    const unwrap=side==='sell'&&r.pair==='native',params={tokenIn,tokenOut,fee:10000,recipient:unwrap?router.target:owner,deadline:BigInt((await provider.getBlock('latest')).timestamp+300),amountIn:input,amountOutMinimum:minimum,sqrtPriceLimitX96:0};
    if(unwrap)return mined(router['multicall(uint256,bytes[])'](params.deadline,[router.interface.encodeFunctionData('exactInputSingle',[params]),router.interface.encodeFunctionData('unwrapWETH9(uint256,address)',[minimum,owner])]));
    return mined(router['multicall(uint256,bytes[])'](params.deadline,[router.interface.encodeFunctionData('exactInputSingle',[params])],{value:side==='buy'&&r.pair==='native'?input:0}));
  }
  async function state(account = '0') {
    const owner = await signerFor(account).getAddress();
    await indexer.sync();
    const items = await Promise.all(listings().map(async r => ({...r,rewardPolicy:tokens.find(t=>t.address===r.address)?.rewardPolicy,rewardVault:tokens.find(t=>t.address===r.address)?.rewardVault,spotPrice:Number(r.spotPrice),balance:formatUnits(await new Contract(r.address,config.contracts.token.abi,provider).balanceOf(owner),18)})));
    return {wallet:owner,balance:formatUnits(await provider.getBalance(owner),18),nativeBalance:formatUnits(await provider.getBalance(owner),18),nativeSymbol:'ETH',wrappedNativeBalance:dex?formatUnits(await v3.weth.balanceOf(owner),18):undefined,tokens:items,indexer:indexer.status(),activity,treasuryBalance:formatUnits(await provider.getBalance(addresses[2]),18)};
  }
  async function getQuote(body) {
    const r = recordFor(body.token), m = await market(r);
    if (!['buy','sell'].includes(body.side)) throw new Error('Choose buy or sell.');
    const input = amount(body.amount,body.side === 'buy'?decimals(r):18);
    if(dex && await original(r).pool()!==ZeroAddress){const out=await dexQuote(r,body.side,input);return {out:formatUnits(out,body.side==='buy'?18:decimals(r)),fee:formatUnits(input/100n,body.side==='buy'?decimals(r):18),feeSymbol:body.side==='buy'?r.quoteSymbol:r.symbol,quoteSymbol:r.quoteSymbol};}
    const [out,fee] = body.side === 'buy'?await m.quoteBuy(input):await m.quoteSell(input);
    return {out:formatUnits(out,body.side === 'buy'?18:decimals(r)),fee:formatUnits(fee,decimals(r)),quoteSymbol:r.quoteSymbol};
  }
  if (seed) for (const [name,symbol,firstBuy,pair,account] of [['Orbit Club','ORBIT','0.1','native','0'],['Pixel Party','PIXEL','0.05','native','1'],['Lucky Sprout','LUCK','0.03','native','0']]) await execute('launch',{name,symbol,firstBuy,pair,account});
  await indexer.sync();
  return {config,state,getQuote,indexer,listings,provider,rewards,transact(action,body) { const result = queue.then(async () => { const result=action==='reward-x-finish'?await rewards.finishX(body):action==='reward-x-start'?await rewards.startX(body):action==='reward-claim'?await rewards.claim(body):action==='reward-verify'?await rewards.verify(body):action==='reward-challenge'?await rewards.challenge(body):action==='reward-process'?(await rewards.tick(),{message:'Reward treasuries processed.'}):await execute(action,body); if(['launch','buy','sell','withdraw','graduate'].includes(action))await rewards.tick(); try {await indexer.sync();} catch {result.message += " Indexing pending; refresh to retry.";} return result;}); queue = result.catch(() => {}); return result; },async close() {await queue; await indexer.close(); provider.destroy(); await connection.close();}};
}
