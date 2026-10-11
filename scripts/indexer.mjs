import {JsonRpcProvider,Contract} from 'ethers';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {compileContracts} from './compile.mjs';
import {v3Artifacts} from '../packages/core/uniswap.mjs';
import {EvmIndexer} from '../packages/indexer/evm-indexer.mjs';

// Read-only worker. No wallet/private key or transaction submission.
const rpc=process.env.ELPIDA_RPC_URL,factory=process.env.ELPIDA_FACTORY;
const fromBlock=Number(process.env.ELPIDA_FROM_BLOCK),confirmations=Number(process.env.ELPIDA_CONFIRMATIONS??12);
if(!rpc || !/^0x[a-fA-F0-9]{40}$/.test(factory??'') || !Number.isSafeInteger(fromBlock) || fromBlock<0 || !Number.isSafeInteger(confirmations) || confirmations<0)throw new Error('Set ELPIDA_RPC_URL, ELPIDA_FACTORY, ELPIDA_FROM_BLOCK and optionally ELPIDA_CONFIRMATIONS.');
const provider=new JsonRpcProvider(rpc,undefined,{cacheTimeout:-1});
const chainId=Number((await provider.getNetwork()).chainId);
const version=Number(await new Contract(factory,['function MODEL_VERSION() view returns(uint256)'],provider).MODEL_VERSION());
if(![3,4,5,8,9].includes(version))throw new Error('Only Elpida models 3, 4, 5, 8 and 9 are supported.');
const compiled=compileContracts(),artifact=n=>({abi:compiled[`contracts/evm/src/${n}.sol`][n].abi});
const dex=[5,9].includes(version),beta=[4,8].includes(version);
const contracts={factory:artifact(dex?'ElpidaDexFactory':beta?'ElpidaBetaFactory':'ElpidaLaunchFactory'),curve:artifact(dex?'ElpidaDexCurve':beta?'ElpidaBetaCurve':'ElpidaLaunchCurve'),pool:artifact('ElpidaLockedPool'),token:artifact('ElpidaToken'),...(dex?{dexPool:{abi:v3Artifacts.pool.abi},locker:artifact('ElpidaV3FeeLocker'),splitter:artifact('ElpidaFeeSplitter')}:{})};
const root=fileURLToPath(new URL('../',import.meta.url));
const path=process.env.ELPIDA_INDEX_DB??resolve(root,`local-data/index-${chainId}-${factory.toLowerCase()}.sqlite`);
const indexer=new EvmIndexer({provider,factory,contracts,path,chainId,fromBlock,confirmations,nativeSymbol:process.env.ELPIDA_NATIVE_SYMBOL??'ETH'});
if(process.argv.includes('--once')) {
  try {await indexer.sync();console.log(JSON.stringify(indexer.status()));}finally{await indexer.close();provider.destroy();}
}else{
  const port=Number(process.env.ELPIDA_INDEX_PORT??3901);
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(code,data)=>{res.writeHead(code);res.end(JSON.stringify(data));};
    if(req.method!=='GET' || ![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host))return send(403,{error:'Local read access only.'});
    try{const url=new URL(req.url,`http://localhost:${port}`);
      if(url.pathname==='/api/indexer/status')return send(200,indexer.status());
      if(url.pathname==='/api/tokens')return send(200,indexer.listings());
      const match=url.pathname.match(/^\/api\/tokens\/(0x[a-fA-F0-9]{40})(?:\/(trades|candles))?$/);
      if(match){const token=indexer.listings().find(t=>t.address===match[1].toLowerCase());if(!token)return send(404,{error:'Token not found.'});return send(200,match[2]==='trades'?indexer.trades(token.address):match[2]==='candles'?indexer.candles(token.address,Number(url.searchParams.get('interval')??60)):token);}
      return send(404,{error:'Not found.'});
    }catch(e){send(400,{error:e.message});}
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
  console.log(`Read-only indexer: http://localhost:${port}; database: ${path}`);
  try{while(!stopping){try{await indexer.sync();}catch(e){console.error(`Indexing will retry: ${e.message}`);}await new Promise(done=>setTimeout(done,2000));}}
  finally{await new Promise(done=>server.close(done));await indexer.close();provider.destroy();}
}
