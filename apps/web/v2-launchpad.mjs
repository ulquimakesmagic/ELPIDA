// ELPIDA V2.0 in the browser: the operator deploys the labelled V2 test launchpad with its reward contracts, and
// creators launch with their own fee. Trading uses the Model 11 path (v4-launchpad.mjs: same pool design and router).
// NOT AUDITED: test networks with Uniswap v4 (or the labelled test PoolManager) only. Every function takes the connected
// TestnetWallet `w`.
import { Contract, ContractFactory, AbiCoder, Interface, concat, getAddress, parseUnits, formatUnits, isAddress, ZeroAddress } from '/vendor/ethers.js';
import { swapCalldata } from '/dex-router.mjs';
import { quoteNativePairConversion } from './usdc-conversion.mjs';
import { V2, V2_MODEL, V2_FEE_SPLIT, V2_PROPOSED_MIN_FEE_BPS, V2_TESTNET_START_FDV_USD_E6, maxFirstBuyGross, firstBuyCapTokens, virtualToken, splitFee, feeOn } from '/v2-economics.mjs';
import { v4Available, v4PoolManager, v2Deployment, saveV2Deployment, mineHookSalt, hasCode, walletCaughtUp, V4_ROUTER_ABI } from './v4-launchpad.mjs';
import { normalizeMetadata } from './metadata.mjs';
import { prepareUploadProof } from './upload-proof.mjs';

const LABEL = 'ELPIDA V2 test launchpad (Uniswap v4 hook). Not audited; test networks only.';
const TEST_START_USD = Number(V2_TESTNET_START_FDV_USD_E6) / 1e6;
export const V2_FACTORY_ABI = ['function launch(string name,string symbol,address asset,uint256 feeBps,uint256 firstBuy,uint256 minOut,address reward,string uri,bool inUsdc) payable returns(address token,uint256 bought)',
  'function launchFee() view returns(uint256)', 'function nativeVirtualQuote() view returns(uint256)', 'function approvedQuotes(address) view returns(uint256)', 'function treasury() view returns(address)', 'function hook() view returns(address)',
  'function feeUsdc() view returns(address)', 'function usdFeed() view returns(address)', 'function requiresMetadata() view returns(bool)', 'function MODEL_VERSION() view returns(uint256)', 'function startMcapUsd() view returns(uint256)',
  'function setHook(address)', 'function configureUsdPricing(address,uint256,address)', 'function approveQuote(address,uint256)',
  'event Launched(address indexed creator,address indexed token,address indexed quote,uint256 feeBps,uint256 firstBuy,uint256 bought)'];
const HOOK_ABI = ['function factory() view returns(address)', 'function protocolTreasury() view returns(address)', 'function minFeeBps() view returns(uint256)', 'function traderAirdropVault() view returns(address)', 'function flywheelVault() view returns(address)', 'function holderRewardVault() view returns(address)'];
const ERC20 = ['function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'];
const progressKey = chainId => `elpida:v2:deployment:${chainId}:progress`;
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(read, { tries = 15, delay = 2000 } = {}) {
  for (let i = 0; ; i++) { try { return await read(); } catch (e) { if (i >= tries - 1) throw e; await pause(delay); } }
}

/** Whether V2 can run on this network: the same networks as Model 11 (Uniswap v4 or its labelled test copy). */
export const v2Available = net => v4Available(net);

/** Midnight UTC on the 1st of the current month, and today: the reward rounds' starts. */
function roundStarts(now = Date.now()) {
  const d = new Date(now);
  return { month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000, today: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 };
}

/**
 * Deploys the labelled V2 test launchpad with the connected wallet as treasury and reward keeper: the factory ($50 test
 * starting market cap), the trader-airdrop distributor (monthly rounds), the holder-reward distributor (weekly), the
 * flywheel vault, the hook at a mined address (it pays the three contracts directly), pricing, the USDC pair, the
 * router, and the flywheel's router. Each step is saved, so a rejected or failed step resumes where it stopped.
 */
export async function deployV2(w, body = {}) {
  await w.checkNetwork();
  const net = w.net;
  if (net.mainnet) throw new Error('V2 is not approved for mainnet. Nothing was deployed.');
  if (!v2Available(net)) throw new Error(`${net.name} has no Uniswap v4 for V2. Use Base Sepolia, Ethereum Sepolia or BNB Chain testnet.`);
  const manager = v4PoolManager(net);
  if (!manager) throw new Error(`${net.name} has no Uniswap v4. Deploy the test PoolManager first (same tab). Nothing was deployed.`);
  if (net.v2?.shared?.factory) throw new Error(`The ${net.name} V2 test launchpad is already pinned. Use it for launches.`);
  if (v2Deployment(net)) throw new Error(`A ${net.name} V2 test launchpad was already deployed from this browser (factory ${v2Deployment(net).factory}). Send its addresses to be pinned; nothing was deployed.`);
  const minFeeBps = Number(body.minFeeBps ?? V2_PROPOSED_MIN_FEE_BPS);
  if (!Number.isInteger(minFeeBps) || minFeeBps < 1 || minFeeBps > V2.defaultFeeBps) throw new Error('The minimum fee must be between 0.01% and the 1.25% default.');
  if (!w.oracle?.available) throw new Error(`Verified USD pricing is not configured for ${net.name}. Nothing was deployed.`);
  await w.oraclePrice();
  const poolManager = getAddress(manager);
  if (!await hasCode(w.provider, poolManager, { wait: true, tries: 2 })) throw new Error(`The v4 PoolManager ${poolManager} has no code on ${net.name}. Nothing was deployed.`);
  if (await w.provider.getBalance(w.address) === 0n) throw new Error(`Get ${net.nativeCurrency.symbol} on ${net.name} from a faucet to pay deployment gas.`);
  const response = await fetch('/api/v4-artifacts');
  if (!response.ok) throw new Error('The V2 contracts are unavailable. Nothing was deployed.');
  const all = await response.json(), a = all.v2, progress = read(progressKey(net.chainId)) ?? {};
  const save = () => write(progressKey(net.chainId), progress);
  const fresh = async (key, check) => !!progress[key] && await hasCode(w.provider, progress[key], { wait: true }) && (!check || await settled(() => check(progress[key])));
  // Some wallets (Trust Wallet) build the next transaction from an RPC a block behind and reuse a spent nonce ("nonce
  // too low", "replacement transaction underpriced"). Every step names its nonce (the highest of the wallet's and the
  // site's pending counts and the last one sent + 1) and a step refused that way is asked again, up to three times.
  let lastNonce = -1;
  const nextNonce = async () => {
    const counts = await Promise.all([w.signer?.provider?.getTransactionCount(w.address, 'pending').catch(() => 0), w.provider.getTransactionCount(w.address, 'pending').catch(() => 0)]);
    return Math.max(...counts.map(Number), lastNonce + 1);
  };
  const stale = e => /nonce too low|nonce has already been used|replacement transaction underpriced|already known/i.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.info?.error?.message ?? ''}`);
  const attempt = async send => {
    for (let i = 0; ; i++) {
      try { return await send({ nonce: await nextNonce() }); }
      catch (e) { if (!stale(e) || i >= 2) throw e; w.onProgress('Your wallet reused a transaction number its network already counted. Asking again in a few seconds…'); await pause(4000 + i * 3000); }
    }
  };
  const deploy = async (art, args, message) => {
    w.onProgress(message);
    const c = await attempt(overrides => new ContractFactory(art.abi, art.bytecode, w.signer).deploy(...args, overrides));
    await c.waitForDeployment(); const tx = c.deploymentTransaction(); lastNonce = tx.nonce; await walletCaughtUp(w, tx.nonce);
    return { address: await c.getAddress(), receipt: await tx.wait() };
  };
  const step = async (send, message) => { const r = await attempt(overrides => w.wait(send(overrides), message)); lastNonce = r?.tx?.nonce ?? lastNonce; await walletCaughtUp(w, r?.tx?.nonce); return r; };
  const starts = progress.starts ?? (progress.starts = roundStarts());
  if (!await fresh('create2')) { progress.create2 = (await deploy(all.create2, [], `Step 1 of 10: confirm the CREATE2 deployer for the hook (${LABEL})…`)).address; save(); }
  if (!await fresh('factory', async f => (await new Contract(f, V2_FACTORY_ABI, w.provider).treasury()).toLowerCase() === w.address.toLowerCase())) {
    const d = await deploy(a.factory, [w.address, TEST_START_USD, true], `Step 2 of 10: confirm the V2 factory ($${TEST_START_USD} test starting market cap, graduation at ×5, token details required)…`);
    progress.factory = d.address; progress.block = d.receipt.blockNumber; progress.hook = null; save();
  }
  const Z = ZeroAddress, keeper = body.keeper && isAddress(body.keeper) ? getAddress(body.keeper) : w.address;
  // Holder rewards of USDC-paired tokens are paid in the native coin: the holder distributor may convert USDC through
  // the network's Uniswap v3 router (SwapRouter02) when it has one.
  const dex = w.dex, usdcAsset = w.oracle.usdc && w.oracle.usdc !== Z ? getAddress(w.oracle.usdc) : null;
  const conversion = dex?.router && dex?.weth && usdcAsset && (dex.routerVersion ?? 2) === 2 ? [usdcAsset, getAddress(dex.router), getAddress(dex.weth)] : [Z, Z, Z];
  // A reward contract from an earlier attempt is reused only if it names the intended operator (the server keeper when
  // it is configured) and, for holder rewards, the intended conversion; otherwise it is deployed again (and the hook,
  // which records the three addresses, after it).
  const READ = ['function operator() view returns(address)', 'function convertible() view returns(address)', 'function swapRouter() view returns(address)'];
  const operatedBy = async x => (await new Contract(x, READ, w.provider).operator()).toLowerCase() === keeper.toLowerCase();
  const converts = async x => { const c = new Contract(x, READ, w.provider); return (await c.convertible()).toLowerCase() === conversion[0].toLowerCase() && (await c.swapRouter()).toLowerCase() === conversion[1].toLowerCase(); };
  if (!await fresh('airdrop', operatedBy)) { progress.airdrop = (await deploy(a.distributor, [keeper, 0, starts.month, 'trader-airdrop', Z, Z, Z], 'Step 3 of 10: confirm the trader-airdrop distributor (monthly rounds, from the 1st of this month UTC)…')).address; progress.hook = null; save(); }
  if (!await fresh('holder', async x => await operatedBy(x) && await converts(x))) { progress.holder = (await deploy(a.distributor, [keeper, 7 * 86400, starts.today, 'holder-rewards', ...conversion], `Step 4 of 10: confirm the holder-reward distributor (weekly rounds${conversion[0] === Z ? '' : ', USDC paid as the native coin'})…`)).address; progress.hook = null; save(); }
  if (!await fresh('flywheel', operatedBy)) { progress.flywheel = (await deploy(a.flywheel, [keeper, progress.factory], 'Step 5 of 10: confirm the flywheel vault (it can only buy V2 tokens and burn them)…')).address; progress.hook = null; save(); }
  const factory = new Contract(progress.factory, V2_FACTORY_ABI, w.signer);
  if (!progress.hook || !await hasCode(w.provider, progress.hook, { wait: true })) {
    const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'], [poolManager, progress.factory, w.address, progress.airdrop, progress.flywheel, progress.holder, minFeeBps]);
    const initCode = concat([a.hook.bytecode, args]);
    w.onProgress('Step 6 of 10: finding the hook address (its last bits are its Uniswap v4 permissions). This takes a few seconds…');
    const mined = await mineHookSalt(progress.create2, initCode);
    if (!await hasCode(w.provider, mined.address)) {
      await step(o => new Contract(progress.create2, ['function deploy(bytes,bytes32) returns(address)'], w.signer).deploy(initCode, mined.salt, o), `Step 6 of 10: confirm the hook at ${mined.address} (minimum fee ${(minFeeBps / 100).toFixed(2)}%)…`);
      if (!await hasCode(w.provider, mined.address, { wait: true })) throw new Error('The hook transaction confirmed, but the network does not show the hook yet. Press the button again in a minute: finished steps are kept.');
    }
    progress.hook = mined.address; progress.minFeeBps = minFeeBps; save();
  }
  const hook = new Contract(progress.hook, HOOK_ABI, w.provider);
  const wiring = await settled(() => Promise.all([hook.factory(), hook.protocolTreasury(), hook.traderAirdropVault(), hook.flywheelVault(), hook.holderRewardVault()]));
  if (wiring.map(x => x.toLowerCase()).join() !== [progress.factory, w.address, progress.airdrop, progress.flywheel, progress.holder].map(x => x.toLowerCase()).join()) throw new Error('The hook is wired to other contracts. Nothing more was sent.');
  if ((await settled(() => factory.hook())) === ZeroAddress) await step(o => factory.setHook(progress.hook, o), 'Step 7 of 10: confirm connecting the hook to the factory…');
  if ((await settled(() => factory.usdFeed())) === ZeroAddress) await step(o => factory.configureUsdPricing(w.oracle.feed, w.oracle.maxAge, w.oracle.usdc ?? ZeroAddress, o), 'Step 8 of 10: confirm verified USD pricing (the $10 launch fee and the starting market cap)…');
  const usdc = w.oracle.usdc && w.oracle.usdc !== ZeroAddress ? getAddress(w.oracle.usdc) : null;
  if (usdc && (await settled(() => factory.approvedQuotes(usdc))) === 0n) {
    const decimals = Number(await new Contract(usdc, ERC20, w.provider).decimals());
    // Virtual quote = start × 5/4, in USDC units.
    await step(o => factory.approveQuote(usdc, V2_TESTNET_START_FDV_USD_E6 * 5n / 4n * 10n ** BigInt(decimals) / 10n ** 6n, o), 'Step 8 of 10: confirm the USDC pair…');
  }
  if (!await fresh('router', async r => (await new Contract(r, V4_ROUTER_ABI, w.provider).hook()).toLowerCase() === progress.hook.toLowerCase())) { progress.router = (await deploy(all.router, [poolManager, progress.hook], 'Step 9 of 10: confirm the V2 router (buys and sells)…')).address; save(); }
  const flywheel = new Contract(progress.flywheel, ['function router() view returns(address)', 'function setRouter(address)'], w.signer);
  if ((await settled(() => flywheel.router())) === ZeroAddress) await step(o => flywheel.setRouter(progress.router, o), 'Step 10 of 10: confirm the flywheel vault\'s router…');
  const record = { factory: progress.factory, hook: progress.hook, router: progress.router, airdrop: progress.airdrop, holder: progress.holder, flywheel: progress.flywheel, keeper, create2: progress.create2, block: progress.block, poolManager, treasury: w.address, minFeeBps: progress.minFeeBps ?? minFeeBps, model: V2_MODEL, deployedAt: Date.now() };
  if (!saveV2Deployment(net, record)) throw new Error(`Deployed, but this browser blocks storage. Save these addresses: ${JSON.stringify(record)}.`);
  try { localStorage.removeItem(progressKey(net.chainId)); } catch { /* kept for a retry */ }
  return { record, message: `The ${net.name} V2 test launchpad is deployed with its reward contracts, from block ${record.block}. Send the addresses to be pinned in networks.mjs (v2.shared) so the site lists its tokens and shows its Rewards analytics.` };
}

const testStock = (w, address) => (w.approvedQuotes ?? []).find(a => a.kind === 'xstock' && a.test && a.address.toLowerCase() === String(address ?? '').toLowerCase()) ?? null;

/** The network's test stocks (approved on its Model 10 launchpad) and whether each is a V2 pair yet. */
export async function v2StockPairs(w) {
  const d = v2Deployment(w.net);
  if (!d) return [];
  const factory = new Contract(d.factory, V2_FACTORY_ABI, w.provider);
  return Promise.all([...new Map((w.approvedQuotes ?? []).filter(a => a.kind === 'xstock' && a.test).map(a => [a.address.toLowerCase(), a])).values()].map(async s => ({ address: s.address, symbol: s.symbol, approved: (await factory.approvedQuotes(s.address)) > 0n })));
}

/**
 * Operator: approves a test stock as a V2 pair at the same starting market cap as on Model 10. V2's virtual quote is
 * start × 5/4 and Model 10's is start × 10/9, so V2's is 9/8 of Model 10's. The V2 treasury signs, once, permanently.
 */
export async function approveV2Stock(w, { asset } = {}) {
  await w.checkNetwork();
  const d = v2Deployment(w.net); if (!d) throw new Error(`There is no V2 launchpad on ${w.net.name}.`);
  const record = testStock(w, asset);
  if (!record?.virtualQuote) throw new Error('Only a test stock approved on this network\'s Model 10 launchpad (Pairs tab) can be approved for V2.');
  const factory = new Contract(d.factory, V2_FACTORY_ABI, w.signer);
  if ((await factory.treasury()).toLowerCase() !== w.address.toLowerCase()) throw new Error('Only the V2 launchpad\'s treasury wallet can approve its pairs. Connect that wallet.');
  if ((await factory.approvedQuotes(record.address)) > 0n) return { message: `${record.symbol} is already a V2 pair.` };
  const result = await step(w, factory.approveQuote(record.address, BigInt(record.virtualQuote) * 9n / 8n), `Approve ${record.symbol} as a V2 test pair (same starting market cap as on Model 10)…`);
  return { hash: result.tx.hash, message: `${record.symbol} is now a V2 test pair on ${w.net.name}. Its holders are paid in ${record.symbol}.` };
}

/** Whole basis points from a percentage typed in the launch form ("1.25" → 125). */
export function feeBpsFrom(percent) {
  const bps = Math.round(Number(percent) * 100);
  if (!Number.isFinite(bps) || Math.abs(Number(percent) * 100 - bps) > 1e-6) throw new Error('Use a fee with at most two decimals.');
  return bps;
}

/** What one trade of `amount` (in the pair asset, as typed) pays, and where each part goes, at `feeBps`. */
export function splitPreview(amount, feeBps, decimals = 18) {
  const gross = parseUnits(String(amount || '0'), decimals), fee = feeOn(gross, feeBps), s = splitFee(fee);
  return { fee: formatUnits(fee, decimals), parts: Object.keys(V2_FEE_SPLIT).map(k => ({ key: k, bps: V2_FEE_SPLIT[k], amount: formatUnits(s[k], decimals) })) };
}

/** The launch form's numbers: the minimum fee, the largest first buy within 3% of supply, and the launch fee. */
export async function v2LaunchTerms(w, { pair = 'native', feeBps = V2.defaultFeeBps, quoteAsset } = {}) {
  const d = v2Deployment(w.net); if (!d) throw new Error('No V2 launchpad on this network.');
  const factory = new Contract(d.factory, V2_FACTORY_ABI, w.provider), hook = new Contract(d.hook, HOOK_ABI, w.provider);
  const asset = pair === 'usdc' ? await factory.feeUsdc() : pair === 'xstock' ? testStock(w, quoteAsset)?.address : ZeroAddress;
  if (!asset) throw new Error('Choose a test stock approved for V2.');
  const decimals = asset === ZeroAddress ? 18 : Number(await new Contract(asset, ERC20, w.provider).decimals());
  const [vQ, minFee, launchFee] = await Promise.all([asset === ZeroAddress ? factory.nativeVirtualQuote() : factory.approvedQuotes(asset), hook.minFeeBps(), factory.launchFee()]);
  if (vQ === 0n) throw new Error('This pair is not approved for V2.');
  return { minFeeBps: Number(minFee), maxFeeBps: V2.maxFeeBps, defaultFeeBps: V2.defaultFeeBps, decimals,
    maxFirstBuy: formatUnits(maxFirstBuyGross({ feeBps, vQ }), decimals), firstBuyCapTokens: formatUnits(firstBuyCapTokens(), 18), launchFee: formatUnits(launchFee, 18) };
}

/** Tokens a first buy would get at launch (the curve's own maths; the hook enforces the 3% cap on what it delivers). */
export function v2FirstBuyTokens(vQ, gross, feeBps) {
  if (gross <= 0n) return 0n;
  const net = gross - feeOn(gross, feeBps), vT = virtualToken();
  return vT * net / (vQ + net);
}

/** Launches on V2: the token, its v4 pool and locked positions, the creator's chosen fee, details on-chain. */
export async function launchV2(w, body) {
  await w.checkNetwork();
  const d = v2Deployment(w.net); if (!d) throw new Error(`There is no V2 launchpad on ${w.net.name} yet. Nothing was submitted.`);
  const factory = new Contract(d.factory, V2_FACTORY_ABI, w.signer), hook = new Contract(d.hook, HOOK_ABI, w.provider);
  if (Number(await factory.MODEL_VERSION()) !== 20 || (await factory.hook()).toLowerCase() !== d.hook.toLowerCase()) throw new Error('The V2 launchpad does not match its record. Nothing was submitted.');
  const name = String(body.name ?? '').trim(), symbol = String(body.symbol ?? '').trim();
  if (!name || new TextEncoder().encode(name).length > 64) throw new Error('Enter a token name of up to 64 characters.');
  if (!V2.tickerPattern.test(symbol)) throw new Error('The ticker must be 1 to 10 letters or digits.');
  const feeBps = Number(body.feeBps ?? V2.defaultFeeBps), minFee = Number(await hook.minFeeBps());
  if (!Number.isInteger(feeBps) || feeBps < minFee || feeBps > V2.maxFeeBps) throw new Error(`Choose a fee from ${(minFee / 100).toFixed(2)}% to 4.00%.`);
  const pair = body.pair ?? 'native';
  if (!['native', 'usdc', 'xstock'].includes(pair)) throw new Error('V2 test launches pair with the native coin, USDC or a test stock approved for V2.');
  const reward = body.reward || w.address;
  if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid creator reward wallet.');
  const asset = pair === 'usdc' ? await factory.feeUsdc() : pair === 'xstock' ? getAddress(testStock(w, body.quoteAsset)?.address ?? ZeroAddress) : ZeroAddress;
  if (pair === 'xstock') {
    if (asset === ZeroAddress) throw new Error('Choose a test stock that is approved on this network.');
    if ((await factory.approvedQuotes(asset)) === 0n) throw new Error(`${testStock(w, asset)?.symbol ?? 'This stock'} is not a V2 pair yet: the operator approves it in the operator panel (Launchpads, V2 card). Pair with the native coin or USDC instead.`);
    await w.stockPreflight?.({ pair: 'xstock', quoteAddress: asset }, 'launch');
  }
  const quote = asset === ZeroAddress ? null : new Contract(asset, ERC20, w.signer), decimals = quote ? Number(await quote.decimals()) : 18;
  const vQ = quote ? await factory.approvedQuotes(asset) : await factory.nativeVirtualQuote();
  if (vQ === 0n) throw new Error('This pair is not approved on this V2 launchpad. Launch with the native coin.');
  // First buy paid in the native coin on a pair-asset launch: a separate swap into the pair asset just before the launch
  // (at most 1% below the quote); the launch then buys with the swap's guaranteed minimum. Any extra stays in the wallet.
  const coin = w.net.nativeCurrency.symbol, payNative = body.firstBuyPayment === 'native' && !!quote;
  if (body.firstBuyPayment === 'native' && !quote) throw new Error('This pair already uses the native coin. Enter the first buy directly. Nothing was submitted.');
  if (payNative && w.net.mainnet) throw new Error('Paying the first buy in the native coin is testnet-only for now. Nothing was submitted.');
  if (payNative && !w.dex?.router) throw new Error(`There is no ${coin} conversion route on ${w.net.name}. Pay the first buy in the pair asset. Nothing was submitted.`);
  const nativeIn = payNative && Number(body.nativeBuy) > 0 ? parseUnits(w.nativeAmount(body.nativeBuy), 18) : 0n;
  const conversion = nativeIn > 0n ? await quoteNativePairConversion({ Contract, provider: w.provider, dex: w.dex, asset, amountIn: nativeIn }) : null;
  const firstBuy = payNative ? conversion?.minimum ?? 0n : parseUnits(String(body.firstBuy || '0'), decimals), cap = maxFirstBuyGross({ feeBps, vQ });
  if (firstBuy > cap) throw new Error(`The first buy can take at most 3% of the supply: up to ${formatUnits(cap, decimals)} ${quote ? await quote.symbol() : w.net.nativeCurrency.symbol} at a ${(feeBps / 100).toFixed(2)}% fee. Nothing was submitted.`);
  const slippage = BigInt(Math.round(Math.min(5, Math.max(0.1, Number(body.slippage ?? 1))) * 100));
  const minOut = v2FirstBuyTokens(vQ, firstBuy, feeBps) * (10000n - slippage) / 10000n;
  const fee = await factory.launchFee(), value = (fee * 101n + 99n) / 100n + (quote ? 0n : firstBuy);
  if (await w.provider.getBalance(w.address) < value + nativeIn) throw new Error(`You need ${formatUnits(value + nativeIn, 18)} ${coin} for the $10 launch fee${quote && !nativeIn ? '' : ' and your first buy'}, plus gas.`);
  if (conversion) {
    const deadline = BigInt((await w.provider.getBlock('latest')).timestamp + 300);
    const data = swapCalldata(Interface, w.dex.routerVersion ?? 2, w.dex.router, { tokenIn: conversion.tokenIn, tokenOut: conversion.tokenOut, fee: conversion.fee, recipient: w.address, amountIn: nativeIn, amountOutMinimum: conversion.minimum }, { deadline, refundETH: true });
    await step(w, w.signer.sendTransaction({ to: w.dex.router, data, value: nativeIn }), `Convert ${formatUnits(nativeIn, 18)} ${coin} to ${await quote.symbol()} for your first buy. This is a separate swap: if the launch then stops, the ${await quote.symbol()} stays in your wallet…`);
  }
  if (quote && firstBuy > 0n) {
    const sym = await quote.symbol();
    if (await quote.balanceOf(w.address) < firstBuy) throw new Error(`You need ${formatUnits(firstBuy, decimals)} ${sym} for the first buy.`);
    if (await quote.allowance(w.address, d.factory) < firstBuy) await step(w, quote.approve(d.factory, firstBuy), `Approve exactly the first buy in ${sym}…`);
  }
  w.onProgress('Preparing public token details for the launch transaction…');
  const payload = JSON.stringify({ network: w.net.key, name, symbol, ...normalizeMetadata(body) }), proof = await prepareUploadProof(payload);
  const response = await fetch('/api/metadata/stage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': w.config.csrf, ...proof }, body: payload });
  const published = await response.json();
  if (!response.ok) throw new Error(published.error ?? 'Metadata publishing failed.');
  if (!/^ipfs:\/\//.test(published.uri) || !['public-ipfs', 'elpida-hosted'].includes(published.storage)) throw new Error('Token details were not staged safely. No launch was submitted.');
  await w.checkNetwork();
  const result = await w.wait(factory.launch(name, symbol, asset, feeBps, firstBuy, minOut, reward, published.uri, false, { value }), `Confirm the V2 launch at a ${(feeBps / 100).toFixed(2)}% fee (${LABEL})…`);
  const event = result.receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
  return { hash: result.tx.hash, token: event?.args.token, feeBps, metadataSaved: true, metadataPublished: true, metadataStorage: published.storage,
    message: `Your token is live on ${w.net.name} (ELPIDA V2, liquidity locked from launch, ${(feeBps / 100).toFixed(2)}% fee for good). ${d.pinned ? '' : 'This launchpad is not pinned yet, so the site lists the token once it is.'}`.trim() };
}

async function step(w, pending, message) { const r = await w.wait(pending, message); await walletCaughtUp(w, r?.tx?.nonce); return r; }
