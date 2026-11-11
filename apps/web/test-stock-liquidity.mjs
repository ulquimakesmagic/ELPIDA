// Operator rehearsal only. No real issuer assets or mainnet configuration are accepted.
// Test networks with a conversion DEX (Malik, 11 November: Robinhood needed one too). Never a mainnet chain id.
export const TEST_LIQUIDITY_CHAINS = { 11155111: 'Ethereum Sepolia', 84532: 'Base Sepolia', 97: 'BNB testnet', 46630: 'Robinhood Chain testnet' };
export const TEST_LIQUIDITY_CHAIN = 11155111;
export const testLiquidityChain = id => Object.hasOwn(TEST_LIQUIDITY_CHAINS, Number(id));
export const TEST_LIQUIDITY_CAP = 100000000000000000n; // 0.1 test ETH
export const TEST_MANAGER_ABI = [
 'function factory() view returns(address)','function WETH9() view returns(address)',
 'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns(address)',
 'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns(uint256,uint128,uint256,uint256)',
 'function refundETH() payable','function multicall(bytes[]) payable returns(bytes[])',
];
const STOCK_ABI=['function stockProvider() view returns(string)','function controller() view returns(address)','function referenceFeed() view returns(address)','function decimals() view returns(uint8)','function paused() view returns(bool)','function blocked(address) view returns(bool)','function balanceOf(address) view returns(uint256)'];
const FEED_ABI=['function decimals() view returns(uint8)','function marketStatus() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export function sqrtInteger(n){if(n<0n)throw Error('Negative square root');if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
export function testLiquidityAmounts({nativeAmount,nativeUsd8,stockUsd8,asset,weth}){
 if(nativeAmount<=0n||nativeAmount>TEST_LIQUIDITY_CAP||nativeUsd8<=0n||stockUsd8<=0n)throw Error('Invalid test liquidity budget or prices. Maximum 0.1 test ETH.');
 const stockAmount=nativeAmount*nativeUsd8/stockUsd8;if(stockAmount<=0n)throw Error('Liquidity amount too small.');
 const assetFirst=BigInt(asset)<BigInt(weth),token0=assetFirst?asset:weth,token1=assetFirst?weth:asset;
 const amount0=assetFirst?stockAmount:nativeAmount,amount1=assetFirst?nativeAmount:stockAmount;
 return {token0,token1,amount0,amount1,stockAmount,sqrtPriceX96:sqrtInteger((amount1<<192n)/amount0)};
}
export async function prepareTestLiquidity({Contract,provider,dex,chainId,asset,account,nativeAmount,nativeUsd8}){
 if(!testLiquidityChain(chainId)||Number((await provider.getNetwork()).chainId)!==Number(chainId))throw Error('Test liquidity setup is restricted to test networks (Ethereum Sepolia, Base Sepolia, BNB testnet, Robinhood testnet).');
 if(!dex?.manager||same(asset,dex.weth))throw Error('Invalid conversion deployment.');
 const manager=new Contract(dex.manager,TEST_MANAGER_ABI,provider);
 if(!same(await manager.factory(),dex.factory)||!same(await manager.WETH9(),dex.weth))throw Error('Liquidity manager does not match the configured DEX.');
 const stock=new Contract(asset,STOCK_ABI,provider);
 if(await stock.stockProvider()!=='ondo-test'||Number(await stock.decimals())!==18||!same(await stock.controller(),account))throw Error('Only the controller of an approved 18-decimal simulated stock can fund this rehearsal.');
 const feed=new Contract(await stock.referenceFeed(),FEED_ABI,provider),block=await provider.getBlock('latest');
 const [round,status,decimals,paused,blocked]=await Promise.all([feed.latestRoundData(),feed.marketStatus(),feed.decimals(),stock.paused(),Promise.all([account,dex.manager,dex.router].map(a=>stock.blocked(a)))]);
 if(Number(decimals)!==8||round[1]<=0n||round[0]<=0n||round[4]<round[0]||round[3]<=0n||round[3]>BigInt(block.timestamp)||BigInt(block.timestamp)-round[3]>172800n||Number(status)>1||paused||blocked.some(Boolean))throw Error('Test stock feed or issuer controls do not permit liquidity setup.');
 const plan=testLiquidityAmounts({nativeAmount,nativeUsd8,stockUsd8:round[1],asset,weth:dex.weth});
 const factory=new Contract(dex.factory,['function getPool(address,address,uint24) view returns(address)','function feeAmountTickSpacing(uint24) view returns(int24)'],provider);
 // 0.3% where the DEX has it (Uniswap); otherwise its 1% tier (PancakeSwap v3 has no 0.3%).
 let fee=3000,spacing=Number(await factory.feeAmountTickSpacing(fee));
 if(spacing!==60){fee=10000;spacing=Number(await factory.feeAmountTickSpacing(fee));if(spacing<=0)throw Error('No 0.3% or 1% V3 conversion tier is available.');}
 const pool=await factory.getPool(plan.token0,plan.token1,fee);let funded=false;
 if(BigInt(pool)!==0n){
  const p=new Contract(pool,['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)','function liquidity() view returns(uint128)','function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)'],provider);
  if(!same(await p.token0(),plan.token0)||!same(await p.token1(),plan.token1)||!same(await p.factory(),dex.factory)||Number(await p.fee())!==fee)throw Error('Unexpected conversion pool identity.');
  if(await stock.blocked(pool))throw Error('Issuer blocked the conversion pool.');
  const price=(await p.slot0())[0],delta=price>plan.sqrtPriceX96?price-plan.sqrtPriceX96:plan.sqrtPriceX96-price;
  funded=await p.liquidity()>0n;
  if(!funded&&price>0n&&delta*10000n>plan.sqrtPriceX96*50n)throw Error('Existing conversion pool price differs from the test reference. No liquidity sent.');
 }
 if(!funded&&(await stock.balanceOf(account)<plan.stockAmount||await provider.getBalance(account)<nativeAmount+500000000000000n))throw Error('Insufficient test stock or test ETH; leave ETH for network gas.');
 const edge=Math.floor(887272/spacing)*spacing;
 return {...plan,asset,account,nativeAmount,fee,tickLower:-edge,tickUpper:edge,pool,funded,quotedAt:Date.now(),deadline:BigInt(block.timestamp+300)};
}
export function testLiquidityCalls(Interface,plan){
 const i=new Interface(TEST_MANAGER_ABI);
 return [i.encodeFunctionData('createAndInitializePoolIfNecessary',[plan.token0,plan.token1,plan.fee,plan.sqrtPriceX96]),i.encodeFunctionData('mint',[{token0:plan.token0,token1:plan.token1,fee:plan.fee,tickLower:plan.tickLower,tickUpper:plan.tickUpper,amount0Desired:plan.amount0,amount1Desired:plan.amount1,amount0Min:plan.amount0*99n/100n,amount1Min:plan.amount1*99n/100n,recipient:plan.account,deadline:plan.deadline}]),i.encodeFunctionData('refundETH',[])];
}
