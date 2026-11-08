// ELPIDA V2.0 fixture: a local cancun chain with Uniswap's own v4 PoolManager and test routers, the V2 hook at a mined
// CREATE2 address with its four fee recipients, and the V2 factory with a mock USD feed and mock USDC. Local only.
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, concat, AbiCoder, ZeroAddress, parseEther } from 'ethers';
import { uniswapV4Artifact } from '../../scripts/compile-v4.mjs';
import { v4Art, mineHookSalt, mined, parse } from './v4-fixture.mjs';

/** $20,000 x 5/4 at $2,500 per ETH: 10 ETH (the factory rounds up; at this price it is exact). */
export const ETH_USD = 2500n;
export const LAUNCH_FEE = parseEther('0.004');
export const USDC_VIRTUAL_QUOTE = 25_000n * 10n ** 6n;
export const MIN_FEE_BPS = 100;

export async function v2Fixture(t, { startFdvUsd = 20_000, minFeeBps = MIN_FEE_BPS } = {}) {
  const connection = await network.create('localCancun'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10; t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(i => provider.getSigner(i))), addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.bytecode ?? a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const [treasury, airdrop, flywheel, holders] = [addresses[2], addresses[5], addresses[6], addresses[7]];
  const manager = await deploy(uniswapV4Artifact('PoolManager'), addresses[0]);
  const router = await deploy(uniswapV4Artifact('PoolSwapTest'), manager.target);
  const liquidityRouter = await deploy(uniswapV4Artifact('PoolModifyLiquidityTest'), manager.target);
  const factory = await deploy(v4Art('ElpidaV2Factory'), treasury, startFdvUsd, false);
  const feed = await deploy(v4Art('MockUsdFeed'), ETH_USD * 10n ** 8n), usdc = await deploy(v4Art('MockUSDC'));
  await mined(factory.connect(signers[2]).configureUsdPricing(feed.target, 86400, usdc.target));
  await mined(factory.connect(signers[2]).approveQuote(usdc.target, USDC_VIRTUAL_QUOTE));
  for (const a of addresses) await mined(usdc.mint(a, 10n ** 12n));
  const create2 = await deploy(v4Art('ElpidaCreate2Deployer'));
  const hookArt = v4Art('ElpidaV2Hook');
  const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'], [manager.target, factory.target, treasury, airdrop, flywheel, holders, minFeeBps]);
  const initCode = concat(['0x' + hookArt.evm.bytecode.object.replace(/^0x/, ''), args]);
  const { salt, address } = mineHookSalt(create2.target, initCode);
  await mined(create2.deploy(initCode, salt));
  const hook = new Contract(address, hookArt.abi, signers[0]);
  await mined(factory.connect(signers[2]).setHook(address));
  const virtualQuote = await factory.nativeVirtualQuote();
  const f = { provider, signers, addresses, treasury, airdrop, flywheel, holders, manager, router, liquidityRouter, factory, hook, create2, deploy, virtualQuote, feed, usdc };
  f.now = async () => (await provider.getBlock('latest')).timestamp;
  f.advance = async s => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  return f;
}

/** Launches a V2 token with fee `feeBps`. `usdc` pairs it with the mock USDC; `inUsdc` pays the fee as 10 USDC. */
export async function launchV2(f, { signer = f.signers[0], feeBps = 125, firstBuy = 0n, reward, name = 'Hope', symbol = 'HOPE', minOut = 0n, usdc = false, inUsdc = false } = {}) {
  const fc = f.factory.connect(signer), asset = usdc ? f.usdc.target : ZeroAddress;
  if (usdc || inUsdc) await mined(f.usdc.connect(signer).approve(f.factory.target, 2n ** 255n));
  const value = (inUsdc ? 0n : LAUNCH_FEE) + (usdc ? 0n : firstBuy);
  const receipt = await mined(usdc || inUsdc
    ? fc.launchWithPayment(name, symbol, asset, feeBps, firstBuy, minOut, reward ?? f.addresses[0], '', inUsdc, { value })
    : fc.launch(name, symbol, feeBps, firstBuy, minOut, reward ?? f.addresses[0], { value }));
  const [ev] = parse(f.factory, receipt, 'Launched'), [launched] = parse(f.hook, receipt, 'Launched');
  const token = new Contract(ev.args.token, v4Art('ElpidaV2Token').abi, signer);
  const key = [asset, ev.args.token, 0, 10, f.hook.target];
  return { receipt, token, key, bought: ev.args.bought, launched: launched.args, quote: usdc ? f.usdc : null };
}

export async function afterWindow(f, l) {
  const launched = (await f.hook.launches(l.token.target)).launchedAt;
  const now = BigInt(await f.now());
  if (now < launched + 61n) await f.advance(Number(launched + 61n - now));
}
