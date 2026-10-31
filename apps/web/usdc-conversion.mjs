// Conversion uses only the application's verified Uniswap deployment and fee USDC.
// Quotes are advisory; the router enforces the user's maximum USDC spend on-chain.
export const CONVERSION_ROUTER_ABI = [
  'function factory() view returns(address)', 'function WETH9() view returns(address)',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns(uint256)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])',
];
export async function quoteUsdcConversion({ Contract, provider, dex, usdc, amountOut, slippageBps = 100 }) {
  if (!dex || !usdc || amountOut <= 0n) throw new Error('USDC conversion is not configured on this network.');
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 500) throw new Error('Choose conversion slippage between 0.1% and 5%.');
  const router=new Contract(dex.router,CONVERSION_ROUTER_ABI,provider);
  const [factory,weth]=await Promise.all([router.factory(),router.WETH9()]);
  if(factory.toLowerCase()!==dex.factory.toLowerCase()||weth.toLowerCase()!==dex.weth.toLowerCase())throw new Error('Conversion router does not match the configured DEX.');
  const coin=new Contract(usdc,['function decimals() view returns(uint8)'],provider);
  if(Number(await coin.decimals())!==6)throw new Error('Conversion requires the configured six-decimal USDC asset.');
  const factoryContract=new Contract(dex.factory,['function getPool(address,address,uint24) view returns(address)'],provider);
  const quoter=new Contract(dex.quoter,['function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)'],provider);
  const routes=[];
  for(const fee of [500,3000,10000]){
    const pool=await factoryContract.getPool(usdc,dex.weth,fee);
    if(/^0x0{40}$/i.test(pool))continue;
    if(await new Contract(pool,['function liquidity() view returns(uint128)'],provider).liquidity()===0n)continue;
    try {
      const [amountIn]=await quoter.quoteExactOutputSingle.staticCall({tokenIn:usdc,tokenOut:dex.weth,amount:amountOut,fee,sqrtPriceLimitX96:0});
      if(amountIn>0n)routes.push({fee,pool,amountIn});
    }catch{/* Insufficient route depth cannot be used for conversion. */}
  }
  if(!routes.length)throw new Error('No funded USDC/native swap route is available. Use native funds or choose a USDC trading pair.');
  routes.sort((a,b)=>a.amountIn<b.amountIn?-1:a.amountIn>b.amountIn?1:0);
  const route=routes[0];
  return {...route,amountOut,maxUsdc:(route.amountIn*BigInt(10000+slippageBps)+9999n)/10000n,quotedAt:Date.now()};
}

export function conversionCalls({Contract,router,dex,usdc,owner,quote}) {
  if(Date.now()-quote.quotedAt>60000)throw new Error('Conversion quote expired. Get a fresh quote before signing.');
  const c=new Contract(router,CONVERSION_ROUTER_ABI);
  return [c.interface.encodeFunctionData('exactOutputSingle',[{tokenIn:usdc,tokenOut:dex.weth,fee:quote.fee,recipient:router,amountOut:quote.amountOut,amountInMaximum:quote.maxUsdc,sqrtPriceLimitX96:0}]),c.interface.encodeFunctionData('unwrapWETH9',[quote.amountOut,owner])];
}

// Pair funding/cash-out is a separate, explicit swap. It never submits the subsequent curve or pool trade.
export async function quoteNativePairConversion({Contract,provider,dex,asset,amountIn,toNative=false,slippageBps=100}) {
  if(!dex?.router||!dex?.factory||!dex?.weth||!dex?.quoter||!/^0x[0-9a-f]{40}$/i.test(asset)||asset.toLowerCase()===dex.weth.toLowerCase())throw new Error('No distinct native/pair conversion route configured.');
  if(typeof amountIn!=='bigint'||amountIn<=0n||!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)throw new Error('Invalid conversion amount or slippage.');
  const router=new Contract(dex.router,['function factory() view returns(address)','function WETH9() view returns(address)'],provider);
  const quoter=new Contract(dex.quoter,['function factory() view returns(address)','function WETH9() view returns(address)','function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)'],provider);
  for(const c of [router,quoter]){
    const [factory,weth]=await Promise.all([c.factory(),c.WETH9()]);
    if(factory.toLowerCase()!==dex.factory.toLowerCase()||weth.toLowerCase()!==dex.weth.toLowerCase())throw new Error('Conversion contracts do not match this network configured DEX.');
  }
  const tokenIn=toNative?asset:dex.weth,tokenOut=toNative?dex.weth:asset;
  const factory=new Contract(dex.factory,['function getPool(address,address,uint24) view returns(address)'],provider),routes=[];
  for(const fee of [100,500,2500,3000,10000]){
    const pool=await factory.getPool(tokenIn,tokenOut,fee);
    if(/^0x0{40}$/i.test(pool))continue;
    const c=new Contract(pool,['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function liquidity() view returns(uint128)'],provider);
    const [a,b,f,pf,liquidity]=await Promise.all([c.token0(),c.token1(),c.factory(),c.fee(),c.liquidity()]);
    if(f.toLowerCase()!==dex.factory.toLowerCase()||Number(pf)!==fee||[a,b].map(x=>x.toLowerCase()).sort().join()!==[tokenIn,tokenOut].map(x=>x.toLowerCase()).sort().join())throw new Error('Conversion pool identity mismatch.');
    if(liquidity===0n)continue;
    try{const [out]=await quoter.quoteExactInputSingle.staticCall({tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96:0});if(out>0n)routes.push({pool,fee,amountOut:out});}catch{/* No executable route at this size. */}
  }
  if(!routes.length)throw new Error('No funded native/pair conversion pool is available on this network. Direct pair-asset trading remains available.');
  routes.sort((a,b)=>a.amountOut>b.amountOut?-1:a.amountOut<b.amountOut?1:0);
  const best=routes[0],minimum=best.amountOut*BigInt(10000-slippageBps)/10000n;
  if(minimum===0n)throw new Error('Conversion amount is too small.');
  return {...best,asset,tokenIn,tokenOut,amountIn,toNative,minimum,quotedAt:Date.now()};
}
