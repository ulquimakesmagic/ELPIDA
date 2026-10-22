import {readFileSync} from 'node:fs';
import {ContractFactory} from 'ethers';
const artifact=(pkg,path)=>JSON.parse(readFileSync(new URL('../../node_modules/@uniswap/'+pkg+'/artifacts/contracts/'+path,import.meta.url),'utf8'));
export const v3Artifacts={factory:artifact('v3-core','UniswapV3Factory.sol/UniswapV3Factory.json'),manager:artifact('v3-periphery','NonfungiblePositionManager.sol/NonfungiblePositionManager.json'),router:JSON.parse(readFileSync(new URL('./vendor/SwapRouter02.json',import.meta.url),'utf8')),quoter:artifact('v3-periphery','lens/QuoterV2.sol/QuoterV2.json'),pool:artifact('v3-core','UniswapV3Pool.sol/UniswapV3Pool.json')};
export const baseSepoliaDex={name:'Uniswap v3',fee:10000,factory:'0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',manager:'0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',router:'0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',quoter:'0xC5290058841028F1614F3A6F0F5816cAd0df5E27',weth:'0x4200000000000000000000000000000000000006',routerVersion:2};

// Graduation DEX per test network. Only `enabled` entries are used by the app; the others are configured for the
// multi-chain fork check (scripts/chain-fork-lifecycle.mjs) and switched on once it passes on that chain.
// Sources: Uniswap sdk-core src/addresses.ts (SEPOLIA_ADDRESSES); pancakeswap/pancake-v3-contracts
// projects/v3-core and projects/v3-periphery deployments/bscTestnet.json. `weth` is confirmed by the fork check
// against the position manager's WETH9(); the app also refuses to deploy if they differ.
// Pool ABI that reads both Uniswap v3 and PancakeSwap v3 pools. PancakeSwap differs in two places that matter to us
// (confirmed from @pancakeswap/v3-core 1.0.2): slot0().feeProtocol is uint32 (Uniswap: uint8; a uint32 declaration
// decodes both), and its Swap event carries two extra protocol-fee fields, so it has a different topic. Both Swap
// events are included; logs are matched by topic, and both decode amount0/amount1 the same way.
const PANCAKE_SWAP_EVENT={type:'event',name:'Swap',anonymous:false,inputs:[
 {indexed:true,name:'sender',type:'address',internalType:'address'},{indexed:true,name:'recipient',type:'address',internalType:'address'},
 {indexed:false,name:'amount0',type:'int256',internalType:'int256'},{indexed:false,name:'amount1',type:'int256',internalType:'int256'},
 {indexed:false,name:'sqrtPriceX96',type:'uint160',internalType:'uint160'},{indexed:false,name:'liquidity',type:'uint128',internalType:'uint128'},
 {indexed:false,name:'tick',type:'int24',internalType:'int24'},{indexed:false,name:'protocolFeesToken0',type:'uint128',internalType:'uint128'},
 {indexed:false,name:'protocolFeesToken1',type:'uint128',internalType:'uint128'}]};
export function v3PoolAbi(){
 const abi=v3Artifacts.pool.abi.map(f=>f.type==='function'&&f.name==='slot0'?{...f,outputs:f.outputs.map(o=>o.name==='feeProtocol'?{...o,type:'uint32',internalType:'uint32'}:o)}:f);
 return [...abi,PANCAKE_SWAP_EVENT];
}

export const testnetDexes={
 'base-sepolia':{...baseSepoliaDex,enabled:true},
 'ethereum-sepolia':{name:'Uniswap v3',fee:10000,factory:'0x0227628f3F023bb0B980b67D528571c95c6DaC1c',manager:'0x1238536071E1c677A632429e3655c799b22cDA52',router:'0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',quoter:'0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',weth:'0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',routerVersion:2,enabled:true},
 'bnb-testnet':{name:'PancakeSwap v3',fee:10000,factory:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',manager:'0x427bF5b37357632377eCbEC9de3626C71A5396c1',router:'0x1b81D678ffb9C0263b24A97847620C99d213eB14',quoter:'0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2',weth:'0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',routerVersion:1,enabled:false},
};
export async function deployLocalV3(signer,wrappedArtifact){
 const deploy=async(art,...args)=>{const c=await new ContractFactory(art.abi,art.bytecode??art.evm.bytecode.object,signer).deploy(...args);await c.waitForDeployment();return c;};
 const weth=await deploy(wrappedArtifact),factory=await deploy(v3Artifacts.factory),manager=await deploy(v3Artifacts.manager,factory.target,weth.target,'0x0000000000000000000000000000000000000000'),router=await deploy(v3Artifacts.router,'0x0000000000000000000000000000000000000000',factory.target,manager.target,weth.target),quoter=await deploy(v3Artifacts.quoter,factory.target,weth.target);
 return {weth,factory,manager,router,quoter,config:{name:'Uniswap v3 (local)',fee:10000,factory:factory.target,manager:manager.target,router:router.target,quoter:quoter.target,weth:weth.target,routerVersion:2}};
}
