// Swap calldata for the two v3 router layouts Elpida graduates into. Shared by the browser wallet and the fork checks.
// Version 2 = Uniswap SwapRouter02 (Base, Ethereum): no deadline in the swap, deadline on multicall(uint256,bytes[]).
// Version 1 = original v3 SwapRouter layout (PancakeSwap v3 periphery on BNB Chain): deadline inside the swap struct,
// multicall(bytes[]). Confirmed from @pancakeswap/v3-periphery 1.0.3 ISwapRouter.sol. Both enforce the deadline.
// `Interface` is passed in (ethers), so this module has no browser-only imports.
export const ROUTER_ABIS = Object.freeze({
  2: ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)', 'function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])', 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable'],
  1: ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)', 'function multicall(bytes[] data) payable returns(bytes[])', 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable'],
});

export function routerAbi(version = 2) {
  const abi = ROUTER_ABIS[version];
  if (!abi) throw new Error(`Unknown router version ${version}.`);
  return abi;
}

/**
 * Calldata for one exact-input, single-hop swap wrapped in the router's multicall, with the deadline enforced.
 * With `unwrapTo`, the output is wrapped native (WETH/WBNB): the swap pays the router, which then unwraps the whole
 * output to `unwrapTo` (at least `amountOutMinimum`).
 */
export function swapCalldata(Interface, version, router, { tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum }, { deadline, unwrapTo = null }) {
  const i = new Interface(routerAbi(version)), payee = unwrapTo ? router : recipient;
  const swap = version === 1
    ? i.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee, recipient: payee, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 }])
    : i.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee, recipient: payee, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 }]);
  const calls = [swap];
  if (unwrapTo) calls.push(i.encodeFunctionData('unwrapWETH9', [amountOutMinimum, unwrapTo]));
  return version === 1 ? i.encodeFunctionData('multicall(bytes[])', [calls]) : i.encodeFunctionData('multicall(uint256,bytes[])', [deadline, calls]);
}
