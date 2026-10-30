import { network } from 'hardhat';
import {createTaxRuntime} from './tax-runtime.mjs';
import {RewardEngine} from './reward-engine.mjs';
import { BrowserProvider, Contract, ContractFactory, formatUnits, parseUnits, isAddress, ZeroAddress } from 'ethers';
import { compileContracts } from '../../scripts/compile.mjs';
import { testnets, evmTestnets } from '../../packages/core/networks.mjs';
import { amount } from './runtime.mjs';
import { EvmIndexer } from '../../packages/indexer/evm-indexer.mjs';
import { indexedActivity, activityOf } from '../web/discovery.mjs';
import {deployLocalV3,v3Artifacts,v3PoolAbi,baseSepoliaDex,testnetDexes} from '../../packages/core/uniswap.mjs';
import { normalizeMetadata } from '../web/metadata.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usdOracles } from '../../packages/core/usd-oracles.mjs';
import { LOCAL_START_FDV_USD, GRADUATION_GRACE_SECONDS, usdQuoteTemplate, startFdvFromVirtualQuote, DEX_MODEL, BETA_MODEL, BASE_FEE_BPS, SALE_CAP } from '../../packages/core/curve-model.mjs';
import { quoteUsdcConversion, conversionCalls, CONVERSION_ROUTER_ABI } from '../web/usdc-conversion.mjs';
// Simulation actions that change chain state. With `journalPath` (on durable storage) each successful
// action is appended to a JSON-lines journal and replayed at startup, with its original time and oracle
// price, so the simulated chain survives restarts and redeploys.
export const JOURNALED_ACTIONS = ['launch','buy','sell','withdraw','graduate','reopen','reward-stock-faucet','reward-claim','convert-usdc'];
function readJournal(path){
  if(!path||!existsSync(path))return {entries:[],malformed:0};
  const entries=[];let malformed=0;
  // A torn write at the end of the file, or a line whose action is no longer journaled, is counted rather than lost.
  for(const line of readFileSync(path,'utf8').split('\n')){
    if(!line)continue;
    try{const e=JSON.parse(line);if(JOURNALED_ACTIONS.includes(e.action)&&Number.isFinite(e.at))entries.push(e);else malformed++;}catch{malformed++;}
  }
  return {entries,malformed};
}
export async function createRuntime({seed = true, dex = false, metadataStore = null, metadataPath = null, indexerPath = ":memory:", journalPath = null, log = () => {}} = {}) {
  const {entries:journal,malformed:journalMalformed} = readJournal(journalPath);
  const compiled = compileContracts({includeMocks:true});
  const artifact = name => compiled[`contracts/evm/src/${name}.sol`][name];
  // Replays start the chain shortly before the first recorded action so timestamps can be restored.
  const connection = await network.create(journal.length ? {network:'localTest',override:{initialDate:new Date(journal[0].at-10*60*1000)}} : 'localTest');
  const provider = new BrowserProvider(connection.provider,undefined,{cacheTimeout:-1}); provider.pollingInterval = 10;
  const signers = await Promise.all([0,1,2,3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  // Local-only, labelled mock USDC fee currency; public networks use the verified address registry.
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const local={launchFee:'0.004',startFdv:'2'};
  const v3=dex?await deployLocalV3(signers[0],compiled['tests/fixtures/LocalWrappedETH.sol'].LocalWrappedETH):null;
  let adapter;
  // Native pairs graduate through an adapter whose ERC-20 side is WETH; the native path wraps on migration.
  if(dex){const a=artifact('ElpidaV3MigrationAdapter');adapter=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[0]).deploy(v3.manager.target,v3.weth.target,10000);await adapter.waitForDeployment();}
  const fa = artifact(dex?'ElpidaDexFactory':'ElpidaBetaFactory');
  // Model 10 (DEX): treasury, native adapter, $5,000 starting FDV and a 24 h graduation grace. Model 8 keeps its legacy arguments.
  const factory = await new ContractFactory(fa.abi,fa.evm.bytecode.object,signers[0]).deploy(addresses[2],...(dex?[adapter.target,LOCAL_START_FDV_USD,GRADUATION_GRACE_SECONDS]:[0n,1n])); await factory.waitForDeployment();
  const feedArtifact=compiled['tests/fixtures/MockUsdFeed.sol'].MockUsdFeed;
  const usdFeed=await new ContractFactory(feedArtifact.abi,feedArtifact.evm.bytecode.object,signers[0]).deploy(2500n*10n**8n);await usdFeed.waitForDeployment();
  const feeCoin=await new ContractFactory(mock.abi,mock.evm.bytecode.object,signers[0]).deploy();await feeCoin.waitForDeployment();
  for(const a of addresses.slice(0,2))await(await feeCoin.mint(a,1000_000_000n)).wait();
  await(await factory.connect(signers[2]).configureUsdPricing(usdFeed.target,86400,feeCoin.target)).wait();
  if (dex) {
    const a=artifact('ElpidaV3MigrationAdapter');
    const usdcAdapter=await new ContractFactory(a.abi,a.evm.bytecode.object,signers[2]).deploy(v3.manager.target,feeCoin.target,10000);await usdcAdapter.waitForDeployment();
    await(await factory.connect(signers[2]).approveQuote(feeCoin.target,usdQuoteTemplate(await factory.startFdvUsd(),6),usdcAdapter.target)).wait();
    // Dedicated simulated routing pool, separate from every launch's locked liquidity.
    const routingUsdc=25_000_000_000n,routingEth=parseUnits('10',18);
    await(await feeCoin.mint(addresses[2],routingUsdc)).wait();await(await v3.weth.connect(signers[2]).deposit({value:routingEth})).wait();
    const first=BigInt(feeCoin.target)<BigInt(v3.weth.target),routeToken0=first?feeCoin.target:v3.weth.target,routeToken1=first?v3.weth.target:feeCoin.target,n0=first?routingUsdc:routingEth,n1=first?routingEth:routingUsdc;
    const n=n1*(1n<<192n)/n0;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}
    await(await v3.manager.createAndInitializePoolIfNecessary(routeToken0,routeToken1,3000,x)).wait();
    await(await feeCoin.connect(signers[2]).approve(v3.manager.target,routingUsdc)).wait();await(await v3.weth.connect(signers[2]).approve(v3.manager.target,routingEth)).wait();
    await(await v3.manager.connect(signers[2]).mint({token0:routeToken0,token1:routeToken1,fee:3000,tickLower:-887220,tickUpper:887220,amount0Desired:n0,amount1Desired:n1,amount0Min:1,amount1Min:1,recipient:addresses[2],deadline:BigInt((await provider.getBlock('latest')).timestamp+3600)})).wait();
  }
  async function updatePrice(usd){
    if(!Number.isFinite(usd)||usd<=0)throw new Error('Invalid reference price');
    const b=await provider.getBlock('latest'),r=await usdFeed.roundId()+1n;
    await(await usdFeed.set(BigInt(Math.round(usd*1e8)),b.timestamp,r,r)).wait();
    config.local.launchFee=formatUnits(await factory.launchFee(),18);config.pricing.local={launchFee:config.local.launchFee,startFdv:formatUnits(startFdvFromVirtualQuote(await factory.nativeVirtualQuote(),dex?'dex':'beta'),18)};
    config.local.price={symbol:'ETH',usd,updatedAt:b.timestamp,source:'Simulated on-chain oracle',status:'fresh',maxAge:86400,simulation:true};
  }
  const tokens = [], activity = [];
  const metadata = new Map(metadataPath && existsSync(metadataPath) ? Object.entries(JSON.parse(readFileSync(metadataPath,'utf8'))) : []);
  let taxRuntime,taxPending;
  const ensureTax=async()=>{taxPending??=createTaxRuntime({provider,signers,compiled,feed:usdFeed,coin:feeCoin,wrapped:v3.weth}).then(r=>{taxRuntime=r;config.taxLaunch.deployment=r.config;return r;});return taxPending;};
  const listings = () => { const activity = indexedActivity(indexer.db); return [...indexer.listings().map(r => ({...r,metadata:metadata.get(r.hash) ?? {},...activityOf(activity,r.address)})),...(taxRuntime?.listings()??[])]; };
  function saveMetadata(hash, value) {
    metadata.set(hash,value);
    if(metadataPath){mkdirSync(dirname(metadataPath),{recursive:true});writeFileSync(metadataPath+'.tmp',JSON.stringify(Object.fromEntries(metadata)));renameSync(metadataPath+'.tmp',metadataPath);}
  }
  const rewards = new RewardEngine({compiled,provider,executor:signers[3],verifier:signers[3],tokens,curveAbi:artifact(dex?'ElpidaDexCurve':'ElpidaBetaCurve').abi,tokenAbi:artifact('ElpidaToken').abi,dex:dex?{v3,lockerAbi:artifact('ElpidaV3FeeLocker').abi,splitterAbi:artifact('ElpidaFeeSplitter').abi}:null});
  await rewards.init();
  let queue = Promise.resolve();
  const config = {
    rewardAutomation:{localEnabled:true,publicEnabled:false},
    oracles:usdOracles(),model:dex?DEX_MODEL:BETA_MODEL,dex:dex?v3.config:null,publicDex:baseSepoliaDex,publicDexes:Object.fromEntries(Object.entries(testnetDexes).filter(([,d])=>d.enabled)),pricing:{local:{launchFee:local.launchFee,startFdv:local.startFdv}},local:{chainId:31337,name:'Local devnet',nativeSymbol:'ETH',factory:await factory.getAddress(),treasury:addresses[2],launchFee:local.launchFee,feeUsdc:feeCoin.target,price:{usd:2500,updatedAt:(await provider.getBlock('latest')).timestamp,source:'Simulated on-chain oracle',status:'fresh',maxAge:86400,simulation:true}},
    accounts:addresses.slice(0,2).map((address,i) => ({id:String(i),address,name:i?'Trader':'Creator'})),testnets:evmTestnets,
    plannedTestnets:testnets.filter(n => !n.enabled).map(({key,name,note}) => ({key,name,note})),
    contracts:{...(dex?{dexPool:{abi:v3PoolAbi()},router:{abi:v3Artifacts.router.abi},quoter:{abi:v3Artifacts.quoter.abi},locker:{abi:artifact('ElpidaV3FeeLocker').abi},splitter:{abi:artifact('ElpidaFeeSplitter').abi}}:{}),dexFactory:{abi:artifact('ElpidaDexFactory').abi,bytecode:'0x'+artifact('ElpidaDexFactory').evm.bytecode.object},dexCurve:{abi:artifact('ElpidaDexCurve').abi},adapter:{abi:artifact('ElpidaV3MigrationAdapter').abi,bytecode:'0x'+artifact('ElpidaV3MigrationAdapter').evm.bytecode.object},legacyFactory:{abi:artifact('ElpidaBetaFactory').abi,bytecode:'0x'+artifact('ElpidaBetaFactory').evm.bytecode.object},legacyCurve:{abi:artifact('ElpidaBetaCurve').abi},factory:{abi:fa.abi,bytecode:`0x${fa.evm.bytecode.object}`},token:{abi:artifact('ElpidaToken').abi},curve:{abi:artifact(dex?'ElpidaDexCurve':'ElpidaBetaCurve').abi},pool:{abi:artifact('ElpidaLockedPool').abi},quote:{abi:mock.abi},testAsset:{abi:compiled['contracts/evm/testnet/ElpidaTestAsset.sol'].ElpidaTestAsset.abi,bytecode:'0x'+compiled['contracts/evm/testnet/ElpidaTestAsset.sol'].ElpidaTestAsset.evm.bytecode.object},testOndoStock:{abi:compiled['contracts/evm/testnet/ElpidaTestOndoStock.sol'].ElpidaTestOndoStock.abi,bytecode:'0x'+compiled['contracts/evm/testnet/ElpidaTestOndoStock.sol'].ElpidaTestOndoStock.evm.bytecode.object},testStockFeed:{abi:compiled['contracts/evm/testnet/ElpidaTestStockFeed.sol'].ElpidaTestStockFeed.abi,bytecode:'0x'+compiled['contracts/evm/testnet/ElpidaTestStockFeed.sol'].ElpidaTestStockFeed.evm.bytecode.object}},
  };
  const indexer = new EvmIndexer({provider,factory:await factory.getAddress(),contracts:config.contracts,path:indexerPath,fromBlock:(await factory.deploymentTransaction().wait()).blockNumber});
  // USD price of one launch token for USD-denominated minimum holdings: spot (quote per token) x the quote's USD price. Native uses the simulated oracle, USDC is $1 parity; other pairs have no USD price, so a USD minimum waits.
  rewards.usdPrice = async rec => { const spot = Number(indexer.snapshot(rec.address)?.spotPrice); if (!(spot > 0)) return null; const p = config.local.price; const quoteUsd = rec.pair === 'native' ? (p?.status === 'fresh' ? p.usd : null) : rec.pair === 'usdc' ? 1 : null; return quoteUsd ? spot * quoteUsd : null; };
  config.taxLaunch={available:dex,experimental:true,venue:'Uniswap v2 (local rehearsal)',creatorAllocation:'wallets',taxProtocolBps:3000};
  config.contracts.atomicFactory={abi:artifact('ElpidaAtomicDexFactory').abi,bytecode:'0x'+artifact('ElpidaAtomicDexFactory').evm.bytecode.object};
  for(const [key,name] of [['taxFactory','ElpidaTaxFactory'],['taxCurve','ElpidaTaxCurve'],['taxToken','ElpidaTaxToken'],['taxRouter','ElpidaV2TaxRouter'],['creatorAllocation','ElpidaCreatorAllocation']])config.contracts[key]={abi:artifact(name).abi};
  const combinedIndex=new Proxy(indexer,{get(target,key){
    if(key==='indexFor')return address=>taxRuntime?.record(address)?taxRuntime.index:indexer;
    if(key==='listings')return listings;
    if(['snapshot','trades','candles','holders'].includes(key))return (address,...args)=>taxRuntime?.record(address)?taxRuntime.index[key](address,...args):target[key](address,...args);
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const signerFor = account => { if (account !== '0' && account !== '1') throw new Error('Choose a local demo account.'); return signers[Number(account)]; };
  const recordFor = address => { const r = tokens.find(t => t.address.toLowerCase() === String(address).toLowerCase()); if (!r) throw new Error('Token not found.'); return r; };
  const original = (r, runner = provider) => new Contract(r.curve,config.contracts.curve.abi,runner);
  async function market(r,runner = provider) {
    const curve = original(r,runner), pool = await curve.pool();
    return pool === ZeroAddress ? curve : new Contract(pool,config.contracts.pool.abi,runner);
  }
  const mined = async p => { const tx = await p; await tx.wait(); return tx; };
  // The simulated chain only mines on demand, so quote against the pending block (current time): the
  // anti-snipe fee decays with wall-clock time even when no block has been mined since launch.
  const pending = {blockTag:'pending'};
  const decimals = r => r.pair === 'native' ? 18 : (r.quoteDecimals??6);
  const quoteFor = r => r.pair==='native'?null:new Contract(r.quoteAddress,config.contracts.quote.abi,provider);
  const bps = value => { const p = Number(value ?? '0.5'); if (!Number.isFinite(p) || p < 0.1 || p > 5) throw new Error('Slippage must be between 0.1% and 5%.'); return BigInt(Math.round(p*100)); };
  async function conversionQuote(body) {
    const q=await quoteUsdcConversion({Contract,provider,dex:v3?.config,usdc:feeCoin.target,amountOut:amount(body.nativeAmount,18),slippageBps:Number(bps(body.slippage??'1'))});
    return q;
  }
  async function getConversionQuote(body) {const q=await conversionQuote(body);return {nativeAmount:formatUnits(q.amountOut,18),usdcAmount:formatUnits(q.amountIn,6),maxUsdc:formatUnits(q.maxUsdc,6),quotedAt:q.quotedAt,fee:q.fee};}
  async function execute(action,body) {
    if(action==='launch'&&body.tax){if(!dex)throw new Error('Tax launches require the DEX rehearsal environment.');return (await ensureTax()).launch(body,signerFor(body.account??'0'));}
    if(taxRuntime?.record(body.token))return taxRuntime.execute(action,body,signerFor(body.account??'0'));
    const s = signerFor(body.account ?? '0'), owner = await s.getAddress();
    if(action==='convert-usdc') {
      const q=await conversionQuote(body),ceiling=amount(body.maxUsdc,6);
      if(ceiling<=0n||q.amountIn>ceiling)throw new Error('Conversion exceeds your USDC maximum. Get a new quote.');
      if(await feeCoin.balanceOf(owner)<ceiling)throw new Error('Not enough simulated USDC for conversion.');q.maxUsdc=ceiling;
      await mined(feeCoin.connect(s).approve(v3.router.target,ceiling));
      const router=new Contract(v3.router.target,CONVERSION_ROUTER_ABI,s),calls=conversionCalls({Contract,router:router.target,dex:v3.config,usdc:feeCoin.target,owner,quote:q}),deadline=BigInt((await provider.getBlock('latest')).timestamp+120);
      const tx=await mined(router['multicall(uint256,bytes[])'](deadline,calls));
      return {hash:tx.hash,nativeAmount:formatUnits(q.amountOut,18),message:'Simulated USDC converted to native ETH. Continue with your launch or purchase.'};
    }
    if(action==='reward-stock-faucet'){const price=await rewards.stock.PRICE();const tx=await mined(rewards.stock.connect(s).buy(price,parseUnits('1',18),{value:price}));return {hash:tx.hash,message:`Received 1 simulated TEST-STOCK for ${formatUnits(price,18)} local ETH. This is not an issued xStock.`};}
    if (action === 'launch') {
      if(!['native','usdc'].includes(body.feeCurrency??'native'))throw new Error('Choose native currency or USDC for the launch fee.');
      const details = normalizeMetadata(body);
      const name = String(body.name ?? '').trim(), symbol = String(body.symbol ?? '').trim().toUpperCase();
      if (!name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name and symbol.');
      const pair = body.pair ?? 'native'; if (!['native','usdc','token','xstock'].includes(pair)) throw new Error('Choose an approved trading pair.');
      const paired = pair!=='native';
      let pairAsset=ZeroAddress,pairDecimals=18,pairSymbol='ETH',pairVirtual;
      if(pair==='usdc') {
        if(!dex)throw new Error('USDC trading pairs need the DEX environment.');
        pairAsset=feeCoin.target;pairDecimals=6;pairSymbol='USDC';pairVirtual=(await factory.approvedQuotes(pairAsset)).virtualQuote;
      } else if(paired){
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
          const quoteWhole=Number(formatUnits(await factory.nativeVirtualQuote(),18))/price;
          pairVirtual=parseUnits(quoteWhole.toFixed(12),18);await mined(factory.connect(signers[2]).approveQuote(pairAsset,pairVirtual,customAdapter.target));
        }else pairVirtual=existing.virtualQuote;
      }
      const buy = amount(body.firstBuy??'0',pair === 'native' ? 18 : pairDecimals,true);
      const fee = await factory.launchFee(),inUsdc=body.feeCurrency==='usdc';
      if(inUsdc)await mined(feeCoin.connect(s).approve(factory.target,10_000_000n+(pair==='usdc'?buy:0n)));
      if(await provider.getBalance(owner)<(inUsdc?0n:fee)+(pair==='native'?buy:0n))throw new Error('Not enough ETH for the creation fee and first buy.');
      if(paired&&await new Contract(pairAsset,config.contracts.quote.abi,provider).balanceOf(owner)<buy)throw new Error(`Not enough ${pairSymbol} for the first buy. Buy the paired token first, or use the simulated-stock test-funds button.`);
      const prepared = body.rewardPolicy ? await rewards.prepare(body.rewardPolicy,body.reward||owner,pair,pair==='native'?ZeroAddress:pairAsset) : null;
      const reward = prepared?.vault.target || body.reward || owner;
      if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid reward wallet.');
      const v = paired?pairVirtual:await factory.nativeVirtualQuote();
      const net = buy - buy*125n/10000n, uncapped = await factory.VIRTUAL_TOKEN()*net/(v+net), out = dex && uncapped > SALE_CAP ? SALE_CAP : uncapped;
      const published=dex&&metadataStore&&Object.values(details).some(Boolean)?await metadataStore.publish({name,symbol,...details}):null;
      if(paired&&!(pair==='usdc'&&inUsdc))await mined(new Contract(pairAsset,config.contracts.quote.abi,s).approve(factory.target,buy));
      const tx = await factory.connect(s).launchWithPayment(name,symbol,pairAsset,buy,out*9950n/10000n,reward,published?.uri??'',inUsdc,{value:(inUsdc?0n:fee)+(paired?0n:buy)});
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
    else if (action === 'reopen') {if(!dex)throw new Error('Only model 10 curves can be reopened.');tx = await mined(c.reopen());}
    else if(dex && await c.pool()!==ZeroAddress && (action==='buy'||action==='sell'))tx=await dexTrade(r,s,owner,body,action);
    else if (action === 'withdraw') {
      tx = await mined(c.withdrawFees());
      if (await c.pool() !== ZeroAddress){if(dex){const locker=new Contract(await c.locker(),config.contracts.locker.abi,s);tx=await mined(locker.collectFees());const splitter=new Contract(await c.feeSplitter(),config.contracts.splitter.abi,s);for(const asset of [r.address,r.pair==='native'?v3.weth.target:r.quoteAddress])for(const recipient of [addresses[2],r.reward])tx=await mined(splitter.claim(asset,recipient));}else tx=await mined(m.withdrawFees());}
    } else if (action === 'buy' || action === 'sell') {
      const input = amount(body.amount,action === 'buy'?decimals(r):18);
      const [out] = action === 'buy' ? await m.quoteBuy(input,pending) : await m.quoteSell(input,pending);
      const min = out*(10000n-bps(body.slippage))/10000n;
      if (action === 'sell') {
        await mined(new Contract(r.address,config.contracts.token.abi,s).approve(await m.getAddress(),input));
        tx = await mined(m.sell(input,min));
      } else {
        if (r.pair !== 'native') await mined(quoteFor(r).connect(s).approve(await m.getAddress(),input));
        tx = await mined(m.buy(input,min,{value:r.pair === 'native'?input:0n}));
      }
    } else throw new Error('Unknown action.');
    activity.unshift({type:action === 'graduate'?'Graduation':action === 'reopen'?'Curve reopened':action === 'withdraw'?'Fees paid':action === 'buy'?'Buy':'Sell',symbol:r.symbol,amount:body.amount ?? '',quoteSymbol:r.quoteSymbol,account:owner,hash:tx.hash,time:Date.now()}); activity.splice(100);
    return {hash:tx.hash,message:action === 'reopen'?'Graduation did not happen within 24 hours, so the curve is open for trading again.':action === 'graduate'?dex?'Graduated into Uniswap v3 with permanently locked liquidity.':'Graduated into the locked test pool.':action === 'withdraw'?'Fees distributed to the fixed recipient wallets.':'Trade confirmed.'};
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
    await taxRuntime?.index.sync();
    const items = await Promise.all(listings().map(async r => ({...r,...(r.tax?await taxRuntime.walletRewards(r,owner):{}),rewardPolicy:tokens.find(t=>t.address===r.address)?.rewardPolicy,rewardVault:tokens.find(t=>t.address===r.address)?.rewardVault,spotPrice:Number(r.spotPrice),balance:formatUnits(await new Contract(r.address,config.contracts.token.abi,provider).balanceOf(owner),18)})));
    return {wallet:owner,balance:formatUnits(await provider.getBalance(owner),18),nativeBalance:formatUnits(await provider.getBalance(owner),18),nativeSymbol:'ETH',feeUsdcBalance:formatUnits(await feeCoin.balanceOf(owner),6),pairBalances:{[feeCoin.target]:formatUnits(await feeCoin.balanceOf(owner),6)},wrappedNativeBalance:dex?formatUnits(await v3.weth.balanceOf(owner),18):undefined,tokens:items,indexer:indexer.status(),activity,treasuryBalance:formatUnits(await provider.getBalance(addresses[2]),18)};
  }
  async function getQuote(body) {
    if(taxRuntime?.record(body.token))return taxRuntime.quote(body);
    const r = recordFor(body.token), m = await market(r);
    if (!['buy','sell'].includes(body.side)) throw new Error('Choose buy or sell.');
    const input = amount(body.amount,body.side === 'buy'?decimals(r):18);
    if(dex && await original(r).pool()!==ZeroAddress){const out=await dexQuote(r,body.side,input);return {out:formatUnits(out,body.side==='buy'?18:decimals(r)),fee:formatUnits(input/100n,body.side==='buy'?decimals(r):18),feeSymbol:body.side==='buy'?r.quoteSymbol:r.symbol,quoteSymbol:r.quoteSymbol};}
    if(dex&&body.side==='buy'){
      // Model 10: partial fill of the final buy, plus the live anti-snipe fee rate.
      const [out,fee,spent,feeBps]=await m.previewBuy(input,pending);
      return {out:formatUnits(out,18),fee:formatUnits(fee,decimals(r)),spend:formatUnits(spent,decimals(r)),completesCurve:spent<input,feeBps:Number(feeBps),antiSnipeActive:Number(feeBps)>BASE_FEE_BPS,quoteSymbol:r.quoteSymbol};
    }
    const [out,fee] = body.side === 'buy'?await m.quoteBuy(input,pending):await m.quoteSell(input,pending);
    const feeBps=dex?Number(await m.currentFeeBps(pending)):BASE_FEE_BPS;
    return {out:formatUnits(out,body.side === 'buy'?18:decimals(r)),fee:formatUnits(fee,decimals(r)),feeBps,antiSnipeActive:feeBps>BASE_FEE_BPS,quoteSymbol:r.quoteSymbol};
  }
  async function apply(action,body){
    const result=action==='reward-claim'?await rewards.claim(body):await execute(action,body);
    if(['launch','buy','sell','withdraw','graduate','reopen'].includes(action))await rewards.tick();
    return result;
  }
  let replayed=0,skipped=0;const failures=[];
  if(journal.length){
    for(const [index,entry] of journal.entries()){
      try{
        // The oracle refresh takes the block just before the action's original time.
        const latest=(await provider.getBlock('latest')).timestamp,at=Math.max(latest+1,Math.floor(entry.at/1000)-1);
        await provider.send('evm_setNextBlockTimestamp',[at]);
        await updatePrice(Number(entry.usd)>0?Number(entry.usd):config.local.price?.usd??2500);
        await apply(entry.action,entry.body);replayed++;
      }catch(error){
        skipped++;
        const failure={index,action:entry.action,at:entry.at,code:String(error.code??error.name??'REPLAY').slice(0,40),reason:String(error.shortMessage??error.message??error).slice(0,160)};
        if(failures.length<20)failures.push(failure);
        log(JSON.stringify({event:'simulation_replay_skipped',...failure}));
      }
    }
    const latest=(await provider.getBlock('latest')).timestamp,now=Math.floor(Date.now()/1000);
    if(now>latest)await provider.send('evm_mine',[now]);
    await updatePrice(config.local.price?.usd??2500);
  }
  const record=(action,body,at)=>{if(!journalPath||!JOURNALED_ACTIONS.includes(action))return;mkdirSync(dirname(journalPath),{recursive:true});appendFileSync(journalPath,JSON.stringify({action,body,at,usd:config.local.price?.usd??null})+'\n');};
  const lost=skipped+journalMalformed;
  if(process.env.ELPIDA_REPLAY_STRICT==='1'&&lost>0){
    // Refuse to serve a partial economy rather than quietly dropping entries from the demo chain.
    try{provider.destroy();await connection.close();}catch{}
    throw new Error(`Simulation journal replay lost ${lost} entr${lost===1?'y':'ies'} (${skipped} failed, ${journalMalformed} malformed). ELPIDA_REPLAY_STRICT=1 refuses to start with a partial economy.`);
  }
  // Demo launches on a fresh simulation are journaled like any other action, so replays keep every address.
  if(!journal.length&&seed)for (const [name,symbol,firstBuy,pair,account] of [['Orbit Club','ORBIT','0.1','native','0'],['Pixel Party','PIXEL','0.05','native','1'],['Lucky Sprout','LUCK','0.03','native','0']]){const at=((await provider.getBlock('latest')).timestamp+1)*1000,body={name,symbol,firstBuy,pair,account};await apply('launch',body);record('launch',body,at);}
  config.simulation={durable:Boolean(journalPath),replayed,skipped,malformed:journalMalformed,failures};
  await indexer.sync();
  return {updatePrice,config,state,getQuote,getConversionQuote,indexer:combinedIndex,listings,provider,rewards,transact(action,body) { const result = queue.then(async () => { const started=((await provider.getBlock('latest')).timestamp+1)*1000; const result=action==='reward-x-finish'?await rewards.finishX(body):action==='reward-x-start'?await rewards.startX(body):action==='reward-verify'?await rewards.verify(body):action==='reward-challenge'?await rewards.challenge(body):action==='reward-process'?(await rewards.tick(),{message:'Reward treasuries processed.'}):await apply(action,body); record(action,body,started); try {await indexer.sync();} catch {result.message += " Indexing pending; refresh to retry.";} return result;}); queue = result.catch(() => {}); return result; },async close() {await queue; await taxRuntime?.close(); await indexer.close(); provider.destroy(); await connection.close();}};
}
