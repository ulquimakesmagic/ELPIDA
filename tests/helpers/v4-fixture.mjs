// Model 11 prototype fixture: a local cancun chain with Uniswap's own v4 PoolManager and test routers, the Elpida v4
// hook at a mined CREATE2 address, and the prototype factory. Local only; nothing here is deployed anywhere.
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, keccak256, concat, getBytes, toBeHex, zeroPadValue, parseEther, AbiCoder, ZeroAddress, getAddress } from 'ethers';
import { compileV4, uniswapV4Artifact } from '../../scripts/compile-v4.mjs';

export const v4 = compileV4();
export const v4Art = n => n === 'ElpidaToken' ? v4['contracts/evm/src/ElpidaToken.sol'][n] : v4[`contracts/evm/v4/${n.startsWith('ElpidaV4Hook') ? 'ElpidaV4Hook' : 'ElpidaV4Factory'}.sol`][n];
export const mined = async p => (await p).wait();
/** beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta. */
export const HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
/** Mainnet terms: $5,000 starting FDV at $2,500 per ETH, times 10/9 (Model 10's nativeVirtualQuote). */
export const VIRTUAL_QUOTE = parseEther('2') * 10n / 9n + 1n;
export const LAUNCH_FEE = parseEther('0.004');
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

export async function v4Fixture(t, { virtualQuote = VIRTUAL_QUOTE, launchFee = LAUNCH_FEE } = {}) {
  const connection = await network.create('localCancun'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10; t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i))), addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.bytecode ?? a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const treasury = addresses[2];
  const manager = await deploy(uniswapV4Artifact('PoolManager'), addresses[0]);
  const router = await deploy(uniswapV4Artifact('PoolSwapTest'), manager.target);
  const liquidityRouter = await deploy(uniswapV4Artifact('PoolModifyLiquidityTest'), manager.target);
  const factory = await deploy(v4Art('ElpidaV4Factory'), treasury, virtualQuote, launchFee);
  const create2 = await deploy(v4Art('ElpidaCreate2Deployer'));
  const hookArt = v4Art('ElpidaV4Hook');
  const initCode = concat([hookArt.evm.bytecode.object.startsWith('0x') ? hookArt.evm.bytecode.object : '0x' + hookArt.evm.bytecode.object, AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address'], [manager.target, factory.target, treasury])]);
  const { salt, address } = mineHookSalt(create2.target, initCode);
  await mined(create2.deploy(initCode, salt));
  const hook = new Contract(address, hookArt.abi, signers[0]);
  await mined(factory.connect(signers[2]).setHook(address));
  const f = { provider, signers, addresses, treasury, manager, router, liquidityRouter, factory, hook, create2, deploy, virtualQuote };
  f.now = async () => (await provider.getBlock('latest')).timestamp;
  f.advance = async s => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  f.at = async s => { await provider.send('evm_setNextBlockTimestamp', [s]); };
  return f;
}

export function parse(contract, receipt, name) {
  return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === name);
}

export async function launchV4(f, { signer = f.signers[0], firstBuy = 0n, reward, name = 'Hope', symbol = 'HOPE', minOut = 0n } = {}) {
  const receipt = await mined(f.factory.connect(signer).launch(name, symbol, firstBuy, minOut, reward ?? f.addresses[0], { value: LAUNCH_FEE + firstBuy }));
  const [ev] = parse(f.factory, receipt, 'Launched'), [launched] = parse(f.hook, receipt, 'Launched');
  const token = new Contract(ev.args.token, v4Art('ElpidaToken').abi, signer);
  const key = [ZeroAddress, ev.args.token, 0, 10, f.hook.target];
  return { receipt, token, key, bought: ev.args.bought, launched: launched.args };
}

const SETTINGS = [false, false];
/** Swaps through Uniswap's PoolSwapTest. Buys send `value`; any ETH left over is refunded by the router. */
export async function swap(f, l, { signer = f.signers[1], buy, amount, exactOut = false, value, limit }) {
  const zeroForOne = buy, amountSpecified = exactOut ? amount : -amount;
  const priceLimit = limit ?? (zeroForOne ? MIN_SQRT : MAX_SQRT);
  const approval = buy ? null : await mined(l.token.connect(signer).approve(f.router.target, exactOut ? 2n ** 255n : amount));
  const ethValue = buy ? (value ?? amount) : 0n;
  const receipt = await mined(f.router.connect(signer).swap(l.key, [zeroForOne, amountSpecified, priceLimit], SETTINGS, '0x', { value: ethValue }));
  receipt.extra = approval ? [approval] : [];
  return receipt;
}

/** Runs `action` and returns the ETH (net of gas) and tokens `who` gained; negative when spent. */
export async function delta(f, l, who, action) {
  const eth = await f.provider.getBalance(who), token = await l.token.balanceOf(who);
  const receipts = [].concat(await action()).flatMap(r => [...(r.extra ?? []), r]);
  const gas = receipts.reduce((n, r) => n + (r.from.toLowerCase() === who.toLowerCase() ? r.gasUsed * r.gasPrice : 0n), 0n);
  return { eth: await f.provider.getBalance(who) - eth + gas, token: await l.token.balanceOf(who) - token, receipt: receipts.at(-1) };
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
