// Seeds small native/test-stock conversion pools on the public EVM testnets, so a creator can pay a stock-paired
// launch's first purchase in the native coin (apps/web/launch-conversion.mjs) and buyers can convert. TESTNETS ONLY.
//
//   node scripts/seed-conversion-pools.mjs                      # all four testnets, 0.02 native coin per pool
//   node scripts/seed-conversion-pools.mjs bnb-testnet --native 0.05
//   node scripts/seed-conversion-pools.mjs --dry-run            # plan only, sends nothing
//   node scripts/seed-conversion-pools.mjs --key local-data/flywheel-keeper-evm.key
//
// Signs with local-data/test-liquidity-evm.key (created on the first run; never printed: only its public address is
// shown so you can top it up). For each Ondo-style test stock a launchpad has approved, it mints the stock from the
// test faucet and adds full-range liquidity to the DEX's 1% pool at the stock's test feed price against the
// launchpad's own native/USD feed. Pools that already hold liquidity are left alone. The LP position stays in the
// signing wallet. Test assets have no value; mainnet networks are refused.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, Contract, parseUnits, formatUnits, Interface } from 'ethers';
import { evmTestnets } from '../packages/core/networks.mjs';
import { testnetDexes } from '../packages/core/uniswap.mjs';
import { conversionPoolPlan } from './lib/conversion-pool-plan.mjs';

const MANAGER_ABI = ['function factory() view returns(address)', 'function WETH9() view returns(address)',
  'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns(address)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns(uint256,uint128,uint256,uint256)',
  'function refundETH() payable', 'function multicall(bytes[]) payable returns(bytes[])'];
const STOCK_ABI = ['function symbol() view returns(string)', 'function stockProvider() view returns(string)', 'function referenceFeed() view returns(address)', 'function decimals() view returns(uint8)',
  'function paused() view returns(bool)', 'function blocked(address) view returns(bool)', 'function balanceOf(address) view returns(uint256)', 'function FAUCET_LIMIT() view returns(uint256)',
  'function faucet(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];
const FEED_ABI = ['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
const FACTORY_ABI = ['function usdFeed() view returns(address)', 'function approvedQuotes(address) view returns(uint256 virtualQuote,address adapter)'];
const V3_FACTORY_ABI = ['function getPool(address,address,uint24) view returns(address)', 'function feeAmountTickSpacing(uint24) view returns(int24)'];
const POOL_ABI = ['function liquidity() view returns(uint128)', 'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint32,bool)'];
const FEE = 10000;

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1] ?? null; };
const dryRun = args.includes('--dry-run'); if (dryRun) args.splice(args.indexOf('--dry-run'), 1);
const nativeText = flag('--native') ?? '0.02', keyArg = flag('--key'), api = flag('--api') ?? 'https://elpida.fun';
const nativeAmount = parseUnits(nativeText, 18);
const keys = args.length ? args : evmTestnets.map(n => n.key);

const dir = fileURLToPath(new URL('../local-data/', import.meta.url));
const keyFile = keyArg ? fileURLToPath(new URL(keyArg, new URL('../', import.meta.url))) : `${dir}test-liquidity-evm.key`;
if (!existsSync(keyFile)) {
  if (keyArg) { console.error(`No key file at ${keyArg}.`); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  const w = Wallet.createRandom(); writeFileSync(keyFile, w.privateKey + '\n', { mode: 0o600 });
  console.log(`Created local-data/test-liquidity-evm.key (never shared). Fund this address with test coin on each testnet, then run again:\n  ${w.address}`);
  process.exit(0);
}
const key = readFileSync(keyFile, 'utf8').trim();
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
let failures = 0;

for (const netKey of keys) {
  const net = evmTestnets.find(n => n.key === netKey), dex = testnetDexes[netKey];
  if (!net || net.mainnet || !dex?.enabled || !net.shared?.factory) { console.log(`${netKey}: skipped (not an enabled public EVM testnet with a launchpad and DEX).`); continue; }
  console.log(`\n${net.name}`);
  try {
    const provider = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true }), wallet = new Wallet(key, provider);
    if (Number((await provider.getNetwork()).chainId) !== net.chainId) throw new Error('RPC is on a different chain');
    const manager = new Contract(dex.manager, MANAGER_ABI, wallet), v3 = new Contract(dex.factory, V3_FACTORY_ABI, provider);
    if ((await manager.factory()).toLowerCase() !== dex.factory.toLowerCase() || (await manager.WETH9()).toLowerCase() !== dex.weth.toLowerCase()) throw new Error('position manager does not match the configured DEX');
    const spacing = Number(await v3.feeAmountTickSpacing(FEE)); if (spacing <= 0) throw new Error('the DEX has no 1% fee tier');
    const launchpad = new Contract(net.shared.factory, FACTORY_ABI, provider), nativeFeed = new Contract(await launchpad.usdFeed(), FEED_ABI, provider);
    const [round, nativeDecimals] = await Promise.all([nativeFeed.latestRoundData(), nativeFeed.decimals()]);
    const nativeUsd8 = round[1] * 10n ** 8n / 10n ** BigInt(nativeDecimals);
    console.log(`  ${net.nativeCurrency.symbol} ≈ $${formatUnits(nativeUsd8, 8)} (launchpad feed) · signer ${short(wallet.address)} · ${formatUnits(await provider.getBalance(wallet.address), 18)} ${net.nativeCurrency.symbol}`);
    const listed = await (await fetch(`${api}/api/public/quotes?network=${netKey}`, { signal: AbortSignal.timeout(20000) })).json();
    if (String(listed.factory).toLowerCase() !== net.shared.factory.toLowerCase()) throw new Error('public pair index is for a different launchpad');
    for (const address of listed.assets) {
      const stock = new Contract(address, STOCK_ABI, wallet);
      let provider_ = ''; try { provider_ = await stock.stockProvider(); } catch {}
      if (provider_ !== 'ondo-test') continue;
      const symbol = await stock.symbol();
      try {
        if ((await launchpad.approvedQuotes(address)).adapter === '0x0000000000000000000000000000000000000000') { console.log(`  ${symbol}: not approved on this launchpad, skipped`); continue; }
        if (Number(await stock.decimals()) !== 18 || await stock.paused() || await stock.blocked(wallet.address) || await stock.blocked(dex.manager)) { console.log(`  ${symbol}: paused, blocked or unexpected decimals, skipped`); continue; }
        const feed = new Contract(await stock.referenceFeed(), FEED_ABI, provider), [stockRound, stockDecimals] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
        const stockUsd8 = stockRound[1] * 10n ** 8n / 10n ** BigInt(stockDecimals);
        const plan = conversionPoolPlan({ nativeAmount, nativeUsd8, stockUsd8, asset: address, weth: dex.weth, spacing, fee: FEE });
        const pool = await v3.getPool(plan.token0, plan.token1, FEE);
        if (BigInt(pool) !== 0n) {
          const p = new Contract(pool, POOL_ABI, provider);
          if (await p.liquidity() > 0n) { console.log(`  ${symbol}: pool ${short(pool)} already has liquidity, left alone`); continue; }
          const current = (await p.slot0()).sqrtPriceX96;
          if (current > 0n) { const off = current > plan.sqrtPriceX96 ? current - plan.sqrtPriceX96 : plan.sqrtPriceX96 - current; if (off * 10000n > plan.sqrtPriceX96 * 250n) { console.log(`  ${symbol}: empty pool ${short(pool)} was initialised at a different price, skipped`); continue; } }
        }
        console.log(`  ${symbol} at $${formatUnits(stockUsd8, 8)}: ${nativeText} ${net.nativeCurrency.symbol} + ${formatUnits(plan.stockAmount, 18)} ${symbol}${dryRun ? ' (dry run, nothing sent)' : ''}`);
        if (dryRun) continue;
        const limit = await stock.FAUCET_LIMIT();
        while (await stock.balanceOf(wallet.address) < plan.stockAmount) { const need = plan.stockAmount - await stock.balanceOf(wallet.address); await (await stock.faucet(need < limit ? need : limit)).wait(); }
        if (await stock.allowance(wallet.address, dex.manager) < plan.stockAmount) await (await stock.approve(dex.manager, plan.stockAmount)).wait();
        const i = new Interface(MANAGER_ABI), deadline = BigInt((await provider.getBlock('latest')).timestamp + 600);
        const calls = [i.encodeFunctionData('createAndInitializePoolIfNecessary', [plan.token0, plan.token1, FEE, plan.sqrtPriceX96]),
          i.encodeFunctionData('mint', [{ token0: plan.token0, token1: plan.token1, fee: FEE, tickLower: plan.tickLower, tickUpper: plan.tickUpper, amount0Desired: plan.amount0, amount1Desired: plan.amount1, amount0Min: 0n, amount1Min: 0n, recipient: wallet.address, deadline }]),
          i.encodeFunctionData('refundETH', [])];
        const tx = await manager.multicall(calls, { value: nativeAmount }); await tx.wait();
        if (await stock.allowance(wallet.address, dex.manager) > 0n) await (await stock.approve(dex.manager, 0n)).wait();
        console.log(`    funded: ${net.explorer}/tx/${tx.hash}`);
      } catch (error) { failures++; console.log(`  ${symbol}: failed (${String(error.shortMessage ?? error.message).slice(0, 160)})`); }
    }
  } catch (error) { failures++; console.log(`  failed: ${String(error.shortMessage ?? error.message).slice(0, 160)}`); }
}
process.exit(failures ? 1 : 0);
