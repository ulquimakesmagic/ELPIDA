import {readFileSync} from 'node:fs';
import {ContractFactory} from 'ethers';
const artifact=(pkg,path)=>JSON.parse(readFileSync(new URL('../../node_modules/@uniswap/'+pkg+'/artifacts/contracts/'+path,import.meta.url),'utf8'));
export const v3Artifacts={factory:artifact('v3-core','UniswapV3Factory.sol/UniswapV3Factory.json'),manager:artifact('v3-periphery','NonfungiblePositionManager.sol/NonfungiblePositionManager.json'),router:JSON.parse(readFileSync(new URL('./vendor/SwapRouter02.json',import.meta.url),'utf8')),quoter:artifact('v3-periphery','lens/QuoterV2.sol/QuoterV2.json'),pool:artifact('v3-core','UniswapV3Pool.sol/UniswapV3Pool.json')};
export const baseSepoliaDex={name:'Uniswap v3',fee:10000,factory:'0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',manager:'0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',router:'0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',quoter:'0xC5290058841028F1614F3A6F0F5816cAd0df5E27',weth:'0x4200000000000000000000000000000000000006',routerVersion:2};
export async function deployLocalV3(signer,wrappedArtifact){
 const deploy=async(art,...args)=>{const c=await new ContractFactory(art.abi,art.bytecode??art.evm.bytecode.object,signer).deploy(...args);await c.waitForDeployment();return c;};
 const weth=await deploy(wrappedArtifact),factory=await deploy(v3Artifacts.factory),manager=await deploy(v3Artifacts.manager,factory.target,weth.target,'0x0000000000000000000000000000000000000000'),router=await deploy(v3Artifacts.router,'0x0000000000000000000000000000000000000000',factory.target,manager.target,weth.target),quoter=await deploy(v3Artifacts.quoter,factory.target,weth.target);
 return {weth,factory,manager,router,quoter,config:{name:'Uniswap v3 (local)',fee:10000,factory:factory.target,manager:manager.target,router:router.target,quoter:quoter.target,weth:weth.target,routerVersion:2}};
}
