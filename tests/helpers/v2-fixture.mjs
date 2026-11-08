// ELPIDA V2.0 fixture: a local cancun chain with Uniswap's own v4 PoolManager, the V2 hook at a mined CREATE2 address,
// the V2 factory with a mock ETH/USD feed, mock USDC and a mock issuer-controlled stock, and the Model 11 router (it
// trades any hook with poolKey/currentFeeBps). The four protocol recipients are fresh addresses, so their balances
// start at zero. Local only.
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, concat, AbiCoder, ZeroAddress, Wallet, parseEther } from 'ethers';
import { uniswapV4Artifact } from '../../scripts/compile-v4.mjs';
import { v4Art, mined, mineHookSalt, parse } from './v4-fixture.mjs';

export { v4Art, mined, parse };
export const ETH_USD = 2500n;
/** $10 at $2,500 per ETH. */
export const LAUNCH_FEE = parseEther('0.004');
/** $20,000 × 5/4 = $25,000 of virtual quote: 10 ETH at $2,500, or 25,000 USDC. */
export const NATIVE_VIRTUAL_QUOTE = parseEther('10');
export const USDC_VIRTUAL_QUOTE = 25_000n * 10n ** 6n;
export const TEST_MIN_FEE_BPS = 100;
export const TEST_URI = 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
export const RECIPIENTS = ['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury'];

const hex = s => (s.startsWith('0x') ? s : '0x' + s);

export async function v2Fixture(t, { startMcapUsd = 20_000, minFeeBps = TEST_MIN_FEE_BPS, requireMetadata = false } = {}) {
  const connection = await network.create('localCancun'), provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10; t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i))), addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.bytecode ?? a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const treasury = addresses[2], owner = signers[2];
  const vaults = { traderAirdrop: Wallet.createRandom().address, flywheel: Wallet.createRandom().address, holderRewards: Wallet.createRandom().address };
  const manager = await deploy(uniswapV4Artifact('PoolManager'), addresses[0]);
  const swapRouter = await deploy(uniswapV4Artifact('PoolSwapTest'), manager.target);
  const liquidityRouter = await deploy(uniswapV4Artifact('PoolModifyLiquidityTest'), manager.target);
  const factory = await deploy(v4Art('ElpidaV2Factory'), treasury, startMcapUsd, requireMetadata);
  const feed = await deploy(v4Art('MockUsdFeed'), ETH_USD * 10n ** 8n), usdc = await deploy(v4Art('MockUSDC'));
  const stock = await deploy(v4Art('MockIssuerStock'));
  await mined(factory.connect(owner).configureUsdPricing(feed.target, 86400, usdc.target));
  await mined(factory.connect(owner).approveQuote(usdc.target, USDC_VIRTUAL_QUOTE * BigInt(startMcapUsd) / 20_000n));
  for (const a of addresses) { await mined(usdc.mint(a, 10n ** 12n)); await mined(stock.mint(a, parseEther('1000000'))); }
  const create2 = await deploy(v4Art('ElpidaCreate2Deployer'));
  const hookArt = v4Art('ElpidaV2Hook');
  const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'],
    [manager.target, factory.target, treasury, vaults.traderAirdrop, vaults.flywheel, vaults.holderRewards, minFeeBps]);
  const initCode = concat([hex(hookArt.evm.bytecode.object), args]);
  const { salt, address } = mineHookSalt(create2.target, initCode);
  await mined(create2.deploy(initCode, salt));
  const hook = new Contract(address, hookArt.abi, signers[0]);
  await mined(factory.connect(owner).setHook(address));
  const router = await deploy(v4Art('ElpidaV4Router'), manager.target, address);
  const f = { provider, signers, addresses, treasury, owner, vaults, manager, swapRouter, liquidityRouter, factory, hook, router, feed, usdc, stock, deploy };
  f.recipient = (l, r) => (r === 'creator' ? l.reward : r === 'treasury' ? treasury : vaults[r]);
  f.now = async () => (await provider.getBlock('latest')).timestamp;
  f.advance = async s => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  f.quoteBalance = (l, who) => (l.quote ? l.quote.balanceOf(who) : provider.getBalance(who));
  f.claims = async quote => manager.balanceOf(hook.target, BigInt(quote ?? ZeroAddress));
  return f;
}

/**
 * Launches a V2 token. `pair`: 'native' | 'usdc' | 'stock'. `feeBps` is the token's own fee. The creator vault is a fresh
 * address unless `reward` is given.
 */
export async function launchV2(f, { signer = f.signers[0], pair = 'native', feeBps = 125, firstBuy = 0n, minOut = 0n, name = 'Hope', symbol = 'HOPE', reward, uri = '', inUsdc = false } = {}) {
  const quote = pair === 'usdc' ? f.usdc : pair === 'stock' ? f.stock : null, asset = quote ? quote.target : ZeroAddress;
  reward ??= Wallet.createRandom().address;
  if (quote && firstBuy > 0n) await mined(quote.connect(signer).approve(f.factory.target, firstBuy));
  if (inUsdc) await mined(f.usdc.connect(signer).approve(f.factory.target, 10n * 10n ** 6n));
  const value = (inUsdc ? 0n : LAUNCH_FEE) + (quote ? 0n : firstBuy);
  const receipt = await mined(f.factory.connect(signer).launch(name, symbol, asset, feeBps, firstBuy, minOut, reward, uri, inUsdc, { value }));
  const [ev] = parse(f.factory, receipt, 'Launched'), [launched] = parse(f.hook, receipt, 'Launched');
  const token = new Contract(ev.args.token, v4Art('ElpidaV2Token').abi, signer);
  return { receipt, token, quote, asset, reward, key: [asset, ev.args.token, 0, 10, f.hook.target], bought: ev.args.bought, launched: launched.args };
}

/** Buys or sells through the Elpida router (exact input). Returns the receipt; ERC-20 inputs are approved exactly. */
export async function trade(f, l, { signer = f.signers[1], buy, amount }) {
  const to = await signer.getAddress(), deadline = (await f.now()) + 3600;
  if (buy) {
    if (l.quote) await mined(l.quote.connect(signer).approve(f.router.target, amount));
    return mined(f.router.connect(signer).buy(l.token.target, amount, 0n, to, deadline, { value: l.quote ? 0n : amount }));
  }
  await mined(l.token.connect(signer).approve(f.router.target, amount));
  return mined(f.router.connect(signer).sell(l.token.target, amount, 0n, to, deadline));
}

/** Resolves when `promise` rejects with revert data or a message containing `needle` (a custom error's selector or a
 * require string). The V2 hook's custom errors reach callers through the factory or the PoolManager unchanged. */
export async function revertsWith(promise, needle) {
  let error;
  try { await promise; } catch (e) { error = e; }
  if (!error) throw new Error(`expected a revert with ${needle}`);
  const seen = [error.message, error.data, error.info?.error?.message, error.info?.error?.data, error.error?.message, error.error?.data].filter(Boolean).join(' ');
  if (!seen.toLowerCase().includes(String(needle).replace(/^0x/, '').toLowerCase())) throw new Error(`expected a revert with ${needle}, got: ${seen.slice(0, 400)}`);
}
export const errorSelector = (contract, name) => contract.interface.getError(name).selector;
