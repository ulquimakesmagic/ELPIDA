// Read-only public lifecycle inspection. Never loads keys or submits transactions.
import {Contract,JsonRpcProvider,formatEther,formatUnits,isAddress} from 'ethers';
import {evmTestnets} from '../packages/core/networks.mjs';
import {baseSepoliaDex,v3Artifacts} from '../packages/core/uniswap.mjs';
import {MODEL_VERSIONS} from '../packages/core/curve-model.mjs';

const site=(process.env.ELPIDA_CHECK_URL??'https://elpida-production.up.railway.app').replace(/\/$/,'');
const account=process.argv[2];
if(account&&!isAddress(account))throw new Error('Pass a public EVM wallet address, not a private key.');
async function get(path){const r=await fetch(site+path,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Public endpoint ${path.split('?')[0]} returned ${r.status}`);return r.json();}
const [config,status,tokens]=await Promise.all([get('/api/config'),get('/api/public/status'),get('/api/public/tokens?network=base-sepolia')]);
const net=evmTestnets.find(n=>n.key==='base-sepolia');
const rpc=new JsonRpcProvider(net.rpcUrl,undefined,{batchMaxCount:1});
const report={checkedAt:new Date().toISOString(),site,network:net.key,storageDurable:status.storage.durable,indexer:status.networks[net.key],factory:net.shared.factory,tokens:[],wallet:null};
try{
 if(Number((await rpc.getNetwork()).chainId)!==net.chainId)throw new Error('RPC chain mismatch');
 const factory=new Contract(net.shared.factory,config.contracts.dexFactory.abi,rpc);
 const version=Number(await factory.MODEL_VERSION());
 if(version!==MODEL_VERSIONS[net.shared.model])throw new Error('Factory model mismatch');
 report.modelVersion=version;
 report.metadataVersion=Number(await factory.METADATA_VERSION());
 if(account){
  const usdc=new Contract('0x036CbD53842c5426634e7929541eC2318f3dCF7e',['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)'],rpc);
  const [native,balance,decimals]=await Promise.all([rpc.getBalance(account),usdc.balanceOf(account),usdc.decimals()]);
  report.wallet={address:account,native:formatEther(native),usdc:formatUnits(balance,decimals),hasUsdcLaunchFee:balance>=10n*10n**decimals};
 }
 for(const token of tokens){
  const curve=new Contract(token.curve,config.contracts.dexCurve.abi,rpc);
  const source=await curve.factory(),approved=[net.shared,...(net.legacy??[])].find(f=>f.factory.toLowerCase()===source.toLowerCase());
  const sourceFactory=approved?new Contract(source,config.contracts.dexFactory.abi,rpc):null;
  const [origin,uri,complete]=await Promise.all([sourceFactory?sourceFactory.isElpidaToken(token.address):false,sourceFactory?sourceFactory.tokenMetadataURI(token.address):'',curve.complete()]);
  const pool=await curve.pool();let position=null;
  if(!/^0x0{40}$/i.test(pool)){
   const [lockerAddress,positionId,adapterAddress]=await Promise.all([curve.locker(),curve.positionId(),curve.migrationAdapter()]);
   const locker=new Contract(lockerAddress,['function manager() view returns(address)','function locked() view returns(bool)','function tokenId() view returns(uint256)'],rpc),adapter=new Contract(adapterAddress,['function manager() view returns(address)'],rpc);
   const [managerAddress,locked,lockedId,adapterManager]=await Promise.all([locker.manager(),locker.locked(),locker.tokenId(),adapter.manager()]);
   const manager=new Contract(managerAddress,v3Artifacts.manager.abi,rpc),[owner,details]=await Promise.all([manager.ownerOf(positionId),manager.positions(positionId)]);
   const verified=locked&&lockedId===positionId&&owner.toLowerCase()===lockerAddress.toLowerCase()&&managerAddress.toLowerCase()===baseSepoliaDex.manager.toLowerCase()&&adapterManager.toLowerCase()===managerAddress.toLowerCase()&&details.liquidity>0n;
   position={pool,locker:lockerAddress,positionId:String(positionId),owner,manager:managerAddress,liquidity:String(details.liquidity),custodyVerified:verified};
  }
  const remaining=complete?0n:await curve.completionQuote();
  let metadata='missing-on-chain';
  if(uri){try{await get('/api/metadata/resolve?uri='+encodeURIComponent(uri));metadata='resolved';}catch{metadata='unavailable';}}
  const trades=await get('/api/public/tokens/'+token.address+'/trades?network=base-sepolia');
  report.tokens.push({address:token.address,symbol:token.symbol,factory:source,factoryScope:approved?(source.toLowerCase()===net.shared.factory.toLowerCase()?'active':'legacy'):'unrecognized',verifiedFactoryOrigin:origin,position,metadataURI:uri,metadata,graduated:token.graduated,liquidityLocked:token.liquidityLocked,remainingBuy:formatUnits(remaining,token.quoteDecimals),quoteSymbol:token.quoteSymbol,recentTradeWindow:trades.length,observedBuy:trades.some(t=>t.side==='buy'),observedSell:trades.some(t=>t.side==='sell'),observedDexTrade:trades.some(t=>t.venue==='dexPool')});
 }
 console.log(JSON.stringify(report,null,2));
}finally{rpc.destroy();}
