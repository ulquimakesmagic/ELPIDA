// Read-only public lifecycle inspection. Never loads keys or submits transactions.
import {Contract,JsonRpcProvider,formatEther,formatUnits,isAddress} from 'ethers';
import {evmTestnets} from '../packages/core/networks.mjs';

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
 if(Number(await factory.MODEL_VERSION())!==9)throw new Error('Factory model mismatch');
 report.metadataVersion=Number(await factory.METADATA_VERSION());
 if(account){
  const usdc=new Contract('0x036CbD53842c5426634e7929541eC2318f3dCF7e',['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)'],rpc);
  const [native,balance,decimals]=await Promise.all([rpc.getBalance(account),usdc.balanceOf(account),usdc.decimals()]);
  report.wallet={address:account,native:formatEther(native),usdc:formatUnits(balance,decimals),hasUsdcLaunchFee:balance>=10n*10n**decimals};
 }
 for(const token of tokens){
  const curve=new Contract(token.curve,config.contracts.dexCurve.abi,rpc);
  const [origin,uri,complete]=await Promise.all([factory.isElpidaToken(token.address),factory.tokenMetadataURI(token.address),curve.complete()]);
  const remaining=complete?0n:await curve.completionQuote();
  let metadata='missing-on-chain';
  if(uri){try{await get('/api/metadata/resolve?uri='+encodeURIComponent(uri));metadata='resolved';}catch{metadata='unavailable';}}
  const trades=await get('/api/public/tokens/'+token.address+'/trades?network=base-sepolia');
  report.tokens.push({address:token.address,symbol:token.symbol,verifiedFactoryOrigin:origin,metadataURI:uri,metadata,graduated:token.graduated,liquidityLocked:token.liquidityLocked,remainingBuy:formatUnits(remaining,token.quoteDecimals),quoteSymbol:token.quoteSymbol,observedBuy:trades.some(t=>t.side==='buy'),observedSell:trades.some(t=>t.side==='sell'),observedDexTrade:trades.some(t=>t.venue==='dexPool')});
 }
 console.log(JSON.stringify(report,null,2));
}finally{rpc.destroy();}
