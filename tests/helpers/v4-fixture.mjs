// Model 11 prototype fixture: a local cancun chain with Uniswap's own v4 PoolManager and test routers, the Elpida v4
// hook at a mined CREATE2 address, and the Model 11 factory with a mock USD feed and mock USDC. Local only.
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, keccak256, concat, getBytes, toBeHex, zeroPadValue, parseEther, AbiCoder, ZeroAddress, getAddress } from 'ethers';
import { compileV4, uniswapV4Artifact } from '../../scripts/compile-v4.mjs';

export const v4 = compileV4({ includeMocks: true });
/** Any contract from the v4 build by name (Model 11, the shared token and the test mocks). */
export const v4Art = n => Object.values(v4).find(entries => entries[n]?.evm.bytecode.object)[n];
export const mined = async p => (await p).wait();
/** beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta. */
export const HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
/** Mainnet terms: $5,000 starting FDV at $2,500 per ETH, times 10/9 (Model 10's nativeVirtualQuote, rounded up). */
export const ETH_USD = 2500n;
export const VIRTUAL_QUOTE = parseEther('2') * 10n / 9n + 1n;
/** $10 at $2,500 per ETH. */
export const LAUNCH_FEE = parseEther('0.004');
/** $5,000 x 10/9 in 6-decimal USDC, rounded up (curve-model.mjs usdQuoteTemplate). */
export const USDC_VIRTUAL_QUOTE = (5000n * 10n ** 6n * 10n + 8n) / 9n;
export const TEST_URI = 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
export const MIN_SQRT = 4295128739n + 1n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

/** Finds a salt whose CREATE2 address carries exactly the hook's permission bits. */
export function mineHookSalt(deployer, initCode, flags = HOOK_FLAGS) {
  const codeHash = getBytes(keccak256(initCode)), prefix = getBytes(concat(['0xff', deployer]));
  const buf = new Uint8Array(85); buf.set(prefix, 0); buf.set(codeHash, 53);
  for (let i = 0n; i < 1_000_000n; i++) {
    const salt = getBytes(zeroPadValue(toBeHex(i), 32)); buf.set(salt, 21);
    const address = BigInt('0x' + keccak256(buf).slice(26));
    if ((address & FLAG_MASK) === flags) return { salt: zeroPadValue(toBeHex(i), 32), address: getAddress('0x' + address.toString(16).padStart(40, '0')) };
  }
  throw new Error('no salt found');
}

export async function v4Fixture(t, { startFdvUsd = 5000, requireMetadata = false } = {}) {
  const connection = await network.create('localCancun'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10; t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i))), addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.bytecode ?? a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const treasury = addresses[2];
  const manager = await deploy(uniswapV4Artifact('PoolManager'), addresses[0]);
  const router = await deploy(uniswapV4Artifact('PoolSwapTest'), manager.target);
  const liquidityRouter = await deploy(uniswapV4Artifact('PoolModifyLiquidityTest'), manager.target);
  const factory = await deploy(v4Art('ElpidaV4Factory'), treasury, startFdvUsd, requireMetadata);
  const feed = await deploy(v4Art('MockUsdFeed'), ETH_USD * 10n ** 8n), usdc = await deploy(v4Art('MockUSDC'));
  await mined(factory.connect(signers[2]).configureUsdPricing(feed.target, 86400, usdc.target));
  await mined(factory.connect(signers[2]).approveQuote(usdc.target, USDC_VIRTUAL_QUOTE));
  for (const a of addresses) await mined(usdc.mint(a, 10n ** 12n));
  const create2 = await deploy(v4Art('ElpidaCreate2Deployer'));
  const hookArt = v4Art('ElpidaV4Hook');
  const initCode = concat([hookArt.evm.bytecode.object.startsWith('0x') ? hookArt.evm.bytecode.object : '0x' + hookArt.evm.bytecode.object, AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address'], [manager.target, factory.target, treasury])]);
  const { salt, address } = mineHookSalt(create2.target, initCode);
  await mined(create2.deploy(initCode, salt));
  const hook = new Contract(address, hookArt.abi, signers[0]);
  await mined(factory.connect(signers[2]).setHook(address));
  const virtualQuote = await factory.nativeVirtualQuote();
  const f = { provider, signers, addresses, treasury, manager, router, liquidityRouter, factory, hook, create2, deploy, virtualQuote, feed, usdc };
  f.now = async () => (await provider.getBlock('latest')).timestamp;
  f.advance = async s => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  f.at = async s => { await provider.send('evm_setNextBlockTimestamp', [s]); };
  return f;
}

export function parse(contract, receipt, name) {
  return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === name);
}

/** Launches a token. `usdc` pairs it with the mock USDC (first buy in USDC); `uri` publishes token details. */
export async function launchV4(f, { signer = f.signers[0], firstBuy = 0n, reward, name = 'Hope', symbol = 'HOPE', minOut = 0n, usdc = false, uri = '', inUsdc = false } = {}) {
  const fc = f.factory.connect(signer), asset = usdc ? f.usdc.target : ZeroAddress;
  if (usdc || inUsdc) await mined(f.usdc.connect(signer).approve(f.factory.target, 2n ** 255n));
  const value = (inUsdc ? 0n : LAUNCH_FEE) + (usdc ? 0n : firstBuy);
  const receipt = await mined(usdc || uri || inUsdc
    ? fc.launchWithPayment(name, symbol, asset, firstBuy, minOut, reward ?? f.addresses[0], uri, inUsdc, { value })
    : fc.launch(name, symbol, firstBuy, minOut, reward ?? f.addresses[0], { value }));
  const [ev] = parse(f.factory, receipt, 'Launched'), [launched] = parse(f.hook, receipt, 'Launched');
  const token = new Contract(ev.args.token, v4Art('ElpidaToken').abi, signer);
  const key = [asset, ev.args.token, 0, 10, f.hook.target];
  return { receipt, token, key, bought: ev.args.bought, launched: launched.args, quote: usdc ? f.usdc : null };
}

const SETTINGS = [false, false];
/** Swaps through Uniswap's PoolSwapTest. Native buys send `value` (the router refunds any left over); USDC buys
 * approve the router, which pulls what the swap needs. */
export async function swap(f, l, { signer = f.signers[1], buy, amount, exactOut = false, value, limit }) {
  const zeroForOne = buy, amountSpecified = exactOut ? amount : -amount;
  const priceLimit = limit ?? (zeroForOne ? MIN_SQRT : MAX_SQRT);
  const approval = buy
    ? (l.quote ? await mined(l.quote.connect(signer).approve(f.router.target, 2n ** 255n)) : null)
    : await mined(l.token.connect(signer).approve(f.router.target, exactOut ? 2n ** 255n : amount));
  const ethValue = buy && !l.quote ? (value ?? amount) : 0n;
  const receipt = await mined(f.router.connect(signer).swap(l.key, [zeroForOne, amountSpecified, priceLimit], SETTINGS, '0x', { value: ethValue }));
  receipt.extra = approval ? [approval] : [];
  return receipt;
}

/** Runs `action` and returns the quote (`eth`: ETH net of gas, or the ERC-20 quote) and tokens `who` gained;
 * negative when spent. */
export async function delta(f, l, who, action) {
  const quoteBalance = () => l.quote ? l.quote.balanceOf(who) : f.provider.getBalance(who);
  const eth = await quoteBalance(), token = await l.token.balanceOf(who);
  const receipts = [].concat(await action()).flatMap(r => [...(r.extra ?? []), r]);
  const gas = l.quote ? 0n : receipts.reduce((n, r) => n + (r.from.toLowerCase() === who.toLowerCase() ? r.gasUsed * r.gasPrice : 0n), 0n);
  return { eth: await quoteBalance() - eth + gas, token: await l.token.balanceOf(who) - token, receipt: receipts.at(-1) };
}

export async function poolPrice(f, l) {
  const id = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], l.key));
  // StateLibrary: pools mapping at slot 6; slot0 is the first word of Pool.State.
  const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [id, 6n]));
  const [word] = await new Contract(f.manager.target, ['function extsload(bytes32) view returns (bytes32)'], f.provider).extsload.staticCall(slot).then(v => [v]);
  const value = BigInt(word);
  const liquidity = BigInt(await new Contract(f.manager.target, ['function extsload(bytes32) view returns (bytes32)'], f.provider).extsload(toBeHex(BigInt(slot) + 3n, 32)));
  return { id, sqrtPrice: value & ((1n << 160n) - 1n), tick: BigInt.asIntN(24, (value >> 160n) & 0xffffffn), liquidity };
}
