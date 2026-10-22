import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { swapCalldata, routerAbi } from '../packages/core/dex-router.mjs';
import { testnetDexes, baseSepoliaDex } from '../packages/core/uniswap.mjs';

const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2', ME = '0x00000000000000000000000000000000000000cc', ROUTER = '0x00000000000000000000000000000000000000dd';
const params = { tokenIn: A, tokenOut: B, fee: 10000, recipient: ME, amountIn: 1000n, amountOutMinimum: 900n }, deadline = 1_800_000_000n;

test('version 2 (Uniswap SwapRouter02) is byte-for-byte what the wallet sent before, with and without unwrap', () => {
  const r = new Interface(routerAbi(2));
  for (const unwrap of [false, true]) {
    const legacy = r.encodeFunctionData('multicall(uint256,bytes[])', [deadline, [
      r.encodeFunctionData('exactInputSingle', [{ tokenIn: A, tokenOut: B, fee: 10000, recipient: unwrap ? ROUTER : ME, amountIn: 1000n, amountOutMinimum: 900n, sqrtPriceLimitX96: 0 }]),
      ...(unwrap ? [r.encodeFunctionData('unwrapWETH9', [900n, ME])] : []),
    ]]);
    assert.equal(swapCalldata(Interface, 2, ROUTER, params, { deadline, unwrapTo: unwrap ? ME : null }), legacy);
  }
});

test('version 1 (PancakeSwap v3 SwapRouter) carries the deadline inside the swap and uses multicall(bytes[])', () => {
  const r = new Interface(routerAbi(1));
  const data = swapCalldata(Interface, 1, ROUTER, params, { deadline, unwrapTo: ME });
  const outer = r.decodeFunctionData('multicall(bytes[])', data)[0];
  assert.equal(outer.length, 2);
  const [swap] = r.decodeFunctionData('exactInputSingle', outer[0]);
  assert.equal(swap.deadline, deadline); assert.equal(swap.recipient.toLowerCase(), ROUTER, 'native output is paid to the router, then unwrapped');
  assert.equal(swap.amountOutMinimum, 900n);
  assert.deepEqual([...r.decodeFunctionData('unwrapWETH9', outer[1])].map(String), ['900', ME]);
  assert.throws(() => routerAbi(3), /Unknown router version/);
});

test('testnet DEX config: Base and Ethereum Sepolia are on (fork check passed); BNB Testnet waits for its fork check', () => {
  assert.equal(testnetDexes['base-sepolia'].enabled, true); assert.equal(testnetDexes['base-sepolia'].manager, baseSepoliaDex.manager);
  assert.equal(testnetDexes['ethereum-sepolia'].enabled, true); assert.equal(testnetDexes['ethereum-sepolia'].routerVersion, 2);
  assert.equal(testnetDexes['bnb-testnet'].enabled, false); assert.equal(testnetDexes['bnb-testnet'].routerVersion, 1); assert.match(testnetDexes['bnb-testnet'].name, /PancakeSwap/);
  for (const d of Object.values(testnetDexes)) { assert.equal(d.fee, 10000); for (const k of ['factory', 'manager', 'router', 'quoter', 'weth']) assert.match(d[k], /^0x[0-9a-fA-F]{40}$/, k); }
});
