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
import { checkStockList, stockApprovalGroups } from '/stock-list.mjs';
import { safeBatch } from './safe-batch.mjs';
import { prepareUploadProof } from './upload-proof.mjs';

const LABEL = 'ELPIDA V2 test launchpad (Uniswap v4 hook). Not audited; test networks only.';
const TEST_START_USD = Number(V2_TESTNET_START_FDV_USD_E6) / 1e6;
export const V2_FACTORY_ABI = ['function launch(string name,string symbol,address asset,uint256 feeBps,uint256 firstBuy,uint256 minOut,address reward,string uri,bool inUsdc) payable returns(address token,uint256 bought)',
  'function launchFee() view returns(uint256)', 'function nativeVirtualQuote() view returns(uint256)', 'function approvedQuotes(address) view returns(uint256)', 'function treasury() view returns(address)', 'function hook() view returns(address)',
  'function feeUsdc() view returns(address)', 'function usdFeed() view returns(address)', 'function requiresMetadata() view returns(bool)', 'function MODEL_VERSION() view returns(uint256)', 'function startMcapUsd() view returns(uint256)',
  'function setHook(address)', 'function configureUsdPricing(address,uint256,address)', 'function approveQuote(address,uint256)',
  // Stocks priced at launch (STOCK_FEEDS_VERSION 1; launchpads deployed after 10 November 2026).
  'function STOCK_FEEDS_VERSION() view returns(uint256)', 'function quoteVirtual(address) view returns(uint256)', 'function quoteFeeds(address) view returns(address feed,uint64 maxAge,uint8 feedDecimals,uint8 assetDecimals)', 'function approvePricedQuote(address,address,uint256)',
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

/** 1 when this V2 factory prices stocks at launch from their feeds, 0 for launchpads deployed before that. */
async function stockFeedsVersion(factory) { try { return Number(await factory.STOCK_FEEDS_VERSION()); } catch { return 0; } }
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Whether `asset` is a V2 pair on this factory: a fixed approval, or (newer factories) a feed-priced one. */
export async function v2PairApproved(factory, asset) {
  if ((await factory.approvedQuotes(asset)) > 0n) return true;
  return (await stockFeedsVersion(factory)) > 0 && (await factory.quoteFeeds(asset)).feed !== ZERO_ADDRESS;
}
/** Feed-priced stock pairs: launches wait while the stock's price is older than its limit (market closed, feed paused). */
export const STOCK_PRICE_WAIT = 'The stock\'s price is older than its limit: its market is closed or its price feed is paused. Launches on it open again when the price updates. Nothing was submitted.';
/** The virtual quote a launch with `asset` gets now (the native coin, a fixed approval, or a stock at its feed price). */
export async function v2VirtualQuote(factory, asset) {
  if (asset === ZeroAddress) return factory.nativeVirtualQuote();
  if (!(await stockFeedsVersion(factory))) return factory.approvedQuotes(asset);
  try { return await factory.quoteVirtual(asset); } catch (e) {
    const text = [e.reason, e.shortMessage, e.message].filter(Boolean).join(' ');
    if (/stale/.test(text)) throw new Error(STOCK_PRICE_WAIT);
    if (/stock price/.test(text)) throw new Error('The stock\'s price feed has no valid price right now, so launches on it are paused. Nothing was submitted.');
    throw e;
  }
}

const usdcKey = chainId => `elpida:v2:usdc-distributors:${chainId}`;
/** The network's USDC payout distributors: pinned in networks.mjs (v2.shared.usdcAirdrop / usdcHolder), else deployed from this browser. */
export function v2UsdcDistributors(net) {
  const d = net?.v2?.shared;
  if (d?.usdcAirdrop && d?.usdcHolder) return { airdrop: d.usdcAirdrop, holder: d.usdcHolder, pinned: true };
  const saved = read(usdcKey(net?.chainId));
  return saved?.airdrop && saved?.holder && saved.source?.toLowerCase() === String(d?.airdrop ?? '').toLowerCase() ? { ...saved, pinned: false } : null;
}

/**
 * Deploys the two USDC payout distributors (contracts/evm/v2/ElpidaV2UsdcDistributor.sol) for the pinned V2 launchpad:
 * one fed by the trader-airdrop distributor, one by the holder-reward distributor, each with the same schedule and the
 * server keeper as operator. The keeper moves each finished round's balance into them, converts it to USDC through the
 * network's Uniswap v3 router (at least 97% of the quote) and pays USDC only. Nothing about the hook changes.
 */
export async function deployV2UsdcDistributors(w) {
  const net = w.net, d = v2Deployment(net);
  if (net.mainnet) throw new Error('USDC payouts are not approved for mainnet. Nothing was deployed.');
  if (!d?.pinned || !d.airdrop || !d.holder) throw new Error(`Pin the ${net.name} V2 launchpad first. Nothing was deployed.`);
  if (v2UsdcDistributors(net)) throw new Error(`The ${net.name} USDC payout distributors already exist. Nothing was deployed.`);
  const keeper = w.config?.v2Keeper;
  if (!keeper?.address || !keeper.active) throw new Error('USDC payouts need the Elpida V2 keeper, which is not running on this server. Nothing was deployed.');
  const usdc = w.oracle?.usdc && w.oracle.usdc !== ZeroAddress ? getAddress(w.oracle.usdc) : null, dex = w.dex;
  if (!usdc) throw new Error(`${net.name} has no USDC configured. Nothing was deployed.`);
  if (!dex?.router || !dex?.weth || (dex.routerVersion ?? 2) !== 2) throw new Error(`There is no Uniswap v3 router (SwapRouter02) on ${net.name} to convert rewards to USDC. Nothing was deployed.`);
  const response = await fetch('/api/v4-artifacts');
  const art = response.ok ? (await response.json()).v2?.usdcDistributor : null;
  if (!art?.bytecode) throw new Error('The USDC distributor contract is unavailable on this server. Nothing was deployed.');
  const SCHEDULE = ['function period() view returns(uint256)', 'function genesis() view returns(uint256)'];
  const record = { source: d.airdrop, holderSource: d.holder, usdc, swapRouter: getAddress(dex.router) };
  for (const [kind, source, purpose, n] of [['airdrop', d.airdrop, 'trader-airdrop-usdc', 1], ['holder', d.holder, 'holder-rewards-usdc', 2]]) {
    const c = new Contract(source, SCHEDULE, w.provider), [period, genesis] = await Promise.all([c.period(), c.genesis()]);
    const deployed = await new ContractFactory(art.abi, art.bytecode, w.signer).deploy(keeper.address, period, genesis, purpose, usdc, getAddress(dex.router), getAddress(dex.weth), source);
    const r = await w.wait(Promise.resolve(deployed.deploymentTransaction()), `Step ${n} of 2: confirm the ${kind === 'airdrop' ? 'trader-airdrop' : 'holder-reward'} USDC distributor…`);
    await walletCaughtUp(w, r?.tx?.nonce);
    record[kind] = await deployed.getAddress();
    if (!await hasCode(w.provider, record[kind], { wait: true })) throw new Error('The USDC distributor is not visible on the network yet. Try again.');
    if (kind === 'airdrop' && r?.receipt?.blockNumber) record.block = r.receipt.blockNumber;
  }
  if (!write(usdcKey(net.chainId), record)) throw new Error(`Deployed, but this browser blocks storage. Save these addresses: ${JSON.stringify({ usdcAirdrop: record.airdrop, usdcHolder: record.holder })}.`);
  return { record, message: `The ${net.name} USDC payout distributors are deployed. Send them to be pinned in networks.mjs (v2.shared.usdcAirdrop and usdcHolder); from then on the keeper pays the trader airdrop and holder rewards in USDC.` };
}

const testStock = (w, address) => (w.approvedQuotes ?? []).find(a => a.kind === 'xstock' && a.test && a.address.toLowerCase() === String(address ?? '').toLowerCase()) ?? null;

/** The network's test stocks (approved on its Model 10 launchpad) and whether each is a V2 pair yet. */
export async function v2StockPairs(w) {
  const d = v2Deployment(w.net);
  if (!d) return [];
  const factory = new Contract(d.factory, V2_FACTORY_ABI, w.provider);
  return Promise.all([...new Map((w.approvedQuotes ?? []).filter(a => a.kind === 'xstock' && a.test).map(a => [a.address.toLowerCase(), a])).values()].map(async s => ({ address: s.address, symbol: s.symbol, approved: await v2PairApproved(factory, s.address) })));
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
  if (await v2PairApproved(factory, record.address)) return { message: `${record.symbol} is already a V2 pair.` };
  // Newer launchpads price each stock launch from its feed (the same dollar start every time); older ones take a fixed amount.
  const feed = record.stock?.feed && (await stockFeedsVersion(factory)) ? getAddress(record.stock.feed) : null;
  const result = feed
    ? await step(w, factory.approvePricedQuote(record.address, feed, 4 * 86_400), `Approve ${record.symbol} as a V2 test pair, priced at each launch by its feed…`)
    : await step(w, factory.approveQuote(record.address, BigInt(record.virtualQuote) * 9n / 8n), `Approve ${record.symbol} as a V2 test pair (same starting market cap as on Model 10)…`);
  return { hash: result.tx.hash, message: `${record.symbol} is now a V2 test pair on ${w.net.name}. Its holders are paid in ${record.symbol}.` };
}

/**
 * The verified stock list for this network (config/stocks/<network>.json) against the V2 launchpad: how many stocks are
 * listed, how many are approved, and the approval groups still to sign. Reads only.
 */
export async function v2StockListState(w) {
  const d = v2Deployment(w.net); if (!d?.factory) return null;
  const response = await fetch(`/api/public/stock-list?network=${encodeURIComponent(w.net.key)}`);
  if (response.status === 404) return { listed: 0, approved: 0, groups: [], feeds: false };
  if (!response.ok) throw new Error('The stock list is unavailable right now.');
  const list = checkStockList(await response.json(), w.net.chainId), factory = new Contract(d.factory, V2_FACTORY_ABI, w.provider);
  const feeds = (await stockFeedsVersion(factory)) > 0, approved = new Set();
  for (const s of list.stocks) if (await v2PairApproved(factory, s.address)) approved.add(s.address.toLowerCase());
  const groups = feeds ? stockApprovalGroups({ iface: factory.interface, factory: d.factory, list, approved }) : [];
  return { listed: list.stocks.length, approved: approved.size, groups, feeds, treasury: await factory.treasury(), checkedAt: list.checkedAt, source: list.source };
}

/**
 * Operator: approves every listed stock not yet approved, priced at each launch by its feed. A treasury that is the
 * connected wallet (test networks) signs each call here; a Safe treasury gets one Transaction Builder file per group
 * of 25, to drag into Safe{Wallet}.
 */
export async function approveV2StockList(w) {
  await w.checkNetwork();
  const state = await v2StockListState(w);
  if (!state?.listed) throw new Error(`There is no verified stock list for ${w.net.name} yet. Build it with scripts/stock-list.mjs. Nothing was submitted.`);
  if (!state.feeds) throw new Error('This V2 launchpad was deployed before stocks were priced at launch, so it cannot take the stock list. Nothing was submitted.');
  if (!state.groups.length) return { message: `All ${state.listed} listed stocks are already approved on ${w.net.name}.` };
  if (state.treasury.toLowerCase() === w.address.toLowerCase()) {
    if (w.net.mainnet) throw new Error('On mainnet the treasury is a Safe; connect a wallet that is not the treasury to download the batches. Nothing was submitted.');
    let n = 0;
    for (const group of state.groups) for (const c of group) { await step(w, w.signer.sendTransaction({ to: c.to, data: c.data }), `Approve ${c.symbol} (${++n} of ${state.groups.flat().length}), priced at each launch by its feed…`); }
    return { message: `${n} stocks approved on ${w.net.name}.` };
  }
  const batches = state.groups.map((group, i) => safeBatch({ chainId: w.net.chainId, safe: state.treasury, name: `Elpida V2 stock approvals ${i + 1} of ${state.groups.length}`,
    description: `Approve ${group.map(c => c.symbol).join(', ')} as V2 pairs, each priced at launch by its verified feed (config/stocks/${w.net.key}.json, checked ${state.checkedAt}).`, transactions: group }));
  return { safeBatches: batches, message: `${batches.length} Safe ${batches.length === 1 ? 'batch' : 'batches'} for ${state.groups.flat().length} stocks downloaded. Drag each into Safe{Wallet} → Transaction Builder, check it, then sign and execute.` };
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
  const [vQ, minFee, launchFee] = await Promise.all([v2VirtualQuote(factory, asset), hook.minFeeBps(), factory.launchFee()]);
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
  const split = body.rewardSplit?.length ? creatorSplitTerms(body.rewardSplit) : null, strategy = body.rewardStrategy ?? null, identities = body.rewardIdentities?.length ? identityTerms(body.rewardIdentities, w.address) : null;
  let reward = split || strategy || identities ? null : body.reward || w.address;
  if (!split && !strategy && !identities && (!isAddress(reward) || reward === ZeroAddress)) throw new Error('Enter a valid creator reward wallet.');
  const asset = pair === 'usdc' ? await factory.feeUsdc() : pair === 'xstock' ? getAddress(testStock(w, body.quoteAsset)?.address ?? ZeroAddress) : ZeroAddress;
  if (pair === 'xstock') {
    if (asset === ZeroAddress) throw new Error('Choose a test stock that is approved on this network.');
    if (!(await v2PairApproved(factory, asset))) throw new Error(`${testStock(w, asset)?.symbol ?? 'This stock'} is not a V2 pair yet: the operator approves it in the operator panel (Launchpads, V2 card). Pair with the native coin or USDC instead.`);
    await w.stockPreflight?.({ pair: 'xstock', quoteAddress: asset }, 'launch');
  }
  const quote = asset === ZeroAddress ? null : new Contract(asset, ERC20, w.signer), decimals = quote ? Number(await quote.decimals()) : 18;
  const vQ = await v2VirtualQuote(factory, asset);
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
  // Creator split: an ownerless contract that receives the creator's 30% and lets each wallet claim its fixed share.
  if (split) reward = await creatorSplit(w, split);
  if (strategy) reward = await creatorStrategyVault(w, d, { ...strategy, feeAsset: asset, feeDecimals: decimals });
  if (identities) reward = await identityAllocation(w, identities);
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

/**
 * Checks wallet, X and website allocations: 1 to 8 rows, at least one X or website, shares adding up to 100%. Labels:
 * "wallet", "x:<handle>" (lowercase, no @) or "domain:<name>" (lowercase).
 */
export function identityTerms(rows, me) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 8) throw new Error('Allocations have 1 to 8 recipients. Nothing was submitted.');
  const out = rows.map((r, i) => {
    const bps = Number(r.bps);
    if (!Number.isInteger(bps) || bps <= 0) throw new Error('Every allocation share must be above zero. Nothing was submitted.');
    if (r.kind === 'wallet') { const wallet = r.target || (i === 0 ? me : ''); if (!isAddress(wallet) || wallet === ZeroAddress) throw new Error('Enter a wallet address for every wallet allocation. Nothing was submitted.'); return { label: 'wallet', wallet: getAddress(wallet), bps }; }
    const target = String(r.target ?? '').trim().toLowerCase().replace(/^@/, '');
    if (r.kind === 'x' && !/^[a-z0-9_]{1,15}$/.test(target)) throw new Error('Enter an X handle (letters, digits or _, up to 15). Nothing was submitted.');
    if (r.kind === 'domain' && !/^(?=.{3,70}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(target)) throw new Error('Enter a website domain like community.org. Nothing was submitted.');
    if (!['x', 'domain'].includes(r.kind)) throw new Error('Recipients are wallets, X accounts or websites. Nothing was submitted.');
    return { label: `${r.kind}:${target}`, wallet: ZeroAddress, bps };
  });
  if (out.reduce((a, r) => a + r.bps, 0) !== 10000) throw new Error('Allocation shares must add up to exactly 100%. Nothing was submitted.');
  if (!out.some(r => r.label !== 'wallet')) return null;
  if (new Set(out.filter(r => r.label !== 'wallet').map(r => r.label)).size !== out.filter(r => r.label !== 'wallet').length) throw new Error('Each X account or website can appear once. Nothing was submitted.');
  return out;
}
/** Deploys the allocation (ElpidaV2IdentityAllocation) with the server's V2 keeper as the verifier of X and website rows. */
async function identityAllocation(w, rows) {
  const keeper = w.config.v2Keeper;
  if (!keeper?.address || !keeper.active) throw new Error('X and website allocations need the Elpida V2 keeper, which is not running on this server. Nothing was submitted.');
  const response = await fetch('/api/v4-artifacts');
  const art = response.ok ? (await response.json()).v2?.identityAllocation : null;
  if (!art?.bytecode) throw new Error('The allocation contract is unavailable on this server. Nothing was submitted.');
  const deployed = await new ContractFactory(art.abi, art.bytecode, w.signer).deploy(keeper.address, rows.map(r => r.label), rows.map(r => r.wallet), rows.map(r => r.bps));
  const r = await w.wait(Promise.resolve(deployed.deploymentTransaction()), 'Deploy your allocations. X and website shares stay held until their owners verify…');
  await walletCaughtUp(w, r?.tx?.nonce);
  const address = await deployed.getAddress();
  if (!await hasCode(w.provider, address, { wait: true })) throw new Error('The allocation contract is not visible on the network yet. Try again; nothing else was submitted.');
  return address;
}

const STRATEGY_MODES = { holders: 0, paired: 1, buyback: 2 };
const V3_FACTORY = ['function getPool(address,address,uint24) view returns(address)'];
/**
 * A holder strategy's vault (ElpidaV2CreatorRewards), run by the server's V2 keeper: the strategy and its settings are
 * fixed in it for good. "Buy a reward token" swaps on the network's Uniswap v3 pool between the pair asset and the
 * reward asset, so that pool must hold liquidity now; its fee tier is fixed in the vault.
 */
/**
 * USD per whole unit of a pair asset now, or null: the native coin from the oracle, the network's USDC at $1, a stock
 * from its price feed (a feed-priced V2 approval or a test stock's reference feed), at most 4 days old.
 */
export async function pairUsd(w, asset) {
  if (asset === ZeroAddress) { try { const p = await w.oraclePrice(); return p?.usd > 0 ? p.usd : null; } catch { return null; } }
  if (w.oracle?.usdc && asset.toLowerCase() === String(w.oracle.usdc).toLowerCase()) return 1;
  const FEED = ['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)'];
  let feed = (w.approvedQuotes ?? []).find(a => a.address?.toLowerCase() === asset.toLowerCase())?.stock?.feed ?? null;
  const d = v2Deployment(w.net);
  if (!feed && d?.factory) { try { const q = await new Contract(d.factory, V2_FACTORY_ABI, w.provider).quoteFeeds(asset); if (q.feed !== ZeroAddress) feed = q.feed; } catch { /* older factory */ } }
  if (!feed) return null;
  try {
    const f = new Contract(feed, FEED, w.provider), [round, decimals, block] = await Promise.all([f.latestRoundData(), f.decimals(), w.provider.getBlock('latest')]);
    if (round[1] <= 0n || Number(block.timestamp) - Number(round[3]) > 4 * 86_400) return null;
    return Number(round[1]) / 10 ** Number(decimals);
  } catch { return null; }
}

async function creatorStrategyVault(w, d, { mode, threshold, thresholdUsd, minimumHolding, minimumHoldingUsd, vestingDays, rewardAsset, feeAsset, feeDecimals }) {
  const m = STRATEGY_MODES[mode];
  if (m === undefined) throw new Error('Choose a holder strategy. Nothing was submitted.');
  const keeper = w.config.v2Keeper;
  if (!keeper?.address || !keeper.active) throw new Error('Holder strategies need the Elpida V2 keeper, which is not running on this server. Nothing was submitted.');
  // The threshold is set in USD (Malik, 11 November: "$20 by default, editable"); the contract keeps it in the pair asset
  // at today's price, fixed at launch, and records the USD values. The USD minimum holding is applied at each distribution.
  const usdE6 = v => { const n = Number(v || 0); if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error('USD amounts are from $0 to $1,000,000. Nothing was submitted.'); return BigInt(Math.round(n * 1e6)); };
  const thresholdUsdE6 = thresholdUsd != null && thresholdUsd !== '' ? usdE6(thresholdUsd) : 0n, minimumHoldingUsdE6 = usdE6(minimumHoldingUsd);
  let thresholdRaw;
  if (thresholdUsdE6 > 0n) {
    const usd = await pairUsd(w, feeAsset);
    if (!usd) throw new Error('There is no fresh USD price for the trading pair right now, so a USD threshold cannot be set. Try again shortly. Nothing was submitted.');
    thresholdRaw = parseUnits((Number(thresholdUsdE6) / 1e6 / usd).toFixed(Math.min(feeDecimals, 12)), feeDecimals);
  } else thresholdRaw = parseUnits(String(threshold), feeDecimals);
  const minimumRaw = parseUnits(String(minimumHolding || '0'), 18);
  if (thresholdRaw <= 0n) throw new Error('Set a distribution threshold above zero. Nothing was submitted.');
  const vesting = m === 2 ? BigInt(Math.round(Number(vestingDays) * 86400)) : 0n;
  if (m === 2 && (vesting < 86400n || vesting > 3650n * 86400n)) throw new Error('Vesting must be between 1 and 3,650 days. Nothing was submitted.');
  let reward = ZeroAddress, poolFee = 0;
  if (m === 1) {
    if (!w.dex?.router || !w.dex?.factory || !w.dex?.weth) throw new Error(`There is no Uniswap v3 market on ${w.net.name} for the reward swap. Choose another strategy. Nothing was submitted.`);
    reward = getAddress(rewardAsset ?? ZeroAddress);
    if (reward.toLowerCase() === feeAsset.toLowerCase()) throw new Error('The reward asset is the trading pair itself: choose "Share fees with holders" instead. Nothing was submitted.');
    const a = feeAsset === ZeroAddress ? w.dex.weth : feeAsset, b = reward === ZeroAddress ? w.dex.weth : reward, factory = new Contract(w.dex.factory, V3_FACTORY, w.provider);
    let best = 0n;
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await factory.getPool(a, b, fee); if (/^0x0{40}$/i.test(pool)) continue;
      const liquidity = await new Contract(pool, ['function liquidity() view returns(uint128)'], w.provider).liquidity();
      if (liquidity > best) { best = liquidity; poolFee = fee; }
    }
    if (!poolFee) throw new Error('There is no funded Uniswap v3 pool between the trading pair and that reward asset yet, so fees could not be swapped. Choose another reward asset or strategy. Nothing was submitted.');
  }
  const response = await fetch('/api/v4-artifacts');
  const art = response.ok ? (await response.json()).v2?.creatorRewards : null;
  if (!art?.bytecode) throw new Error('The holder strategy contract is unavailable on this server. Nothing was submitted.');
  const deployed = await new ContractFactory(art.abi, art.bytecode, w.signer).deploy(keeper.address, d.hook, d.router, w.dex?.router ?? ZeroAddress, w.dex?.weth ?? ZeroAddress, poolFee, m, reward, thresholdRaw, minimumRaw, vesting, thresholdUsdE6, minimumHoldingUsdE6);
  const r = await w.wait(Promise.resolve(deployed.deploymentTransaction()), 'Deploy your holder strategy vault. Its strategy and settings are fixed for good; the Elpida keeper runs it…');
  await walletCaughtUp(w, r?.tx?.nonce);
  const address = await deployed.getAddress();
  if (!await hasCode(w.provider, address, { wait: true })) throw new Error('The strategy vault is not visible on the network yet. Try again; nothing else was submitted.');
  return address;
}

/** Checks a creator split: 2 to 8 distinct wallets whose shares (basis points) add up to exactly 100%. */
export function creatorSplitTerms(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8) throw new Error('A creator split has 2 to 8 wallets. Nothing was submitted.');
  const wallets = rows.map(r => { if (!isAddress(r.wallet) || r.wallet === ZeroAddress) throw new Error('Every creator split wallet must be a valid address. Nothing was submitted.'); return getAddress(r.wallet); });
  const shares = rows.map(r => Number(r.bps));
  if (new Set(wallets.map(a => a.toLowerCase())).size !== wallets.length) throw new Error('Each wallet can appear once in a creator split. Nothing was submitted.');
  if (shares.some(b => !Number.isInteger(b) || b <= 0) || shares.reduce((a, b) => a + b, 0) !== 10000) throw new Error('Creator split shares must be positive and add up to exactly 100%. Nothing was submitted.');
  return { wallets, shares };
}
export const SPLIT_ABI = ['function recipients(uint256) view returns(address)', 'function shares(uint256) view returns(uint16)', 'function accounted(address) view returns(uint256)', 'function claimable(address,address) view returns(uint256)', 'function claim(address asset,address recipient) returns(bool)'];
export const V2_HOOK_FEES_ABI = ['function launchOf(address) view returns(address quote,address creatorVault,uint64 launchedAt,uint16 feeBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 liquidityBonus,uint128 accrued)', 'function withdrawFees(address token)'];

/** The split's wallets and shares, or null when the token's creator vault is a plain wallet (or anything else). */
export async function readSplit(provider, vault) {
  if (!vault || vault === ZeroAddress || (await provider.getCode(vault)) === '0x') return null;
  const c = new Contract(vault, SPLIT_ABI, provider), rows = [];
  for (let i = 0; i < 8; i++) { let wallet; try { wallet = await c.recipients(i); } catch { break; } rows.push({ wallet, bps: Number(await c.shares(i)) }); }
  return rows.length >= 2 && rows.reduce((a, r) => a + r.bps, 0) === 10000 ? rows : null;
}

/**
 * A V2 token's creator split, if its creator vault is one: each wallet's share and what it can claim now (synced
 * plus not yet synced). Fees still inside the pool are collected by the payout itself.
 */
export async function creatorSplitState({ provider, net, token }) {
  const d = v2Deployment(net); if (!d?.hook) return null;
  const l = await new Contract(d.hook, V2_HOOK_FEES_ABI, provider).launchOf(token);
  const rows = await readSplit(provider, l.creatorVault); if (!rows) return null;
  const c = new Contract(l.creatorVault, SPLIT_ABI, provider), asset = l.quote;
  const held = asset === ZeroAddress ? await provider.getBalance(l.creatorVault) : await new Contract(asset, ERC20, provider).balanceOf(l.creatorVault);
  const accounted = await c.accounted(asset), fresh = held > accounted ? held - accounted : 0n;
  let assigned = 0n;
  for (const [i, r] of rows.entries()) {
    const part = i + 1 === rows.length ? fresh - assigned : fresh * BigInt(r.bps) / 10000n; assigned += part;
    r.claimable = (await c.claimable(asset, r.wallet)) + part;
  }
  return { vault: l.creatorVault, asset, rows };
}

const STRATEGY_ABI = ['function CREATOR_REWARDS_VERSION() view returns(uint256)', 'function mode() view returns(uint8)', 'function threshold() view returns(uint256)', 'function minimumHolding() view returns(uint256)', 'function vesting() view returns(uint64)',
  'function rewardAsset() view returns(address)', 'function feeAsset() view returns(address)', 'function token() view returns(address)', 'function available(address) view returns(uint256)', 'function roundCount() view returns(uint256)',
  'function rounds(uint256) view returns(address asset,bytes32 root,uint128 total,uint128 claimed,uint32 recipients,uint64 postedAt,uint64 vesting)'];
/**
 * A V2 token's holder strategy, if its creator vault is an ElpidaV2CreatorRewards: the fixed settings, what has
 * gathered toward the threshold (in the vault, plus the creator share still in the pool) and the rounds paid so far.
 */
export async function creatorStrategyState({ provider, net, token }) {
  const d = v2Deployment(net); if (!d?.hook) return null;
  const l = await new Contract(d.hook, V2_HOOK_FEES_ABI, provider).launchOf(token);
  if (!l.creatorVault || l.creatorVault === ZeroAddress || (await provider.getCode(l.creatorVault)) === '0x') return null;
  const v = new Contract(l.creatorVault, STRATEGY_ABI, provider);
  let version; try { version = await v.CREATOR_REWARDS_VERSION(); if (version !== 1n && version !== 2n) return null; } catch { return null; }
  // Version 2 also records the creator's dollar figures: the threshold as chosen, and the minimum holding value.
  let thresholdUsd = null, minimumHoldingUsd = null;
  if (version === 2n) { const u = new Contract(l.creatorVault, ['function thresholdUsdE6() view returns(uint256)', 'function minimumHoldingUsdE6() view returns(uint256)'], provider); const [a, b] = await Promise.all([u.thresholdUsdE6(), u.minimumHoldingUsdE6()]); thresholdUsd = a > 0n ? Number(a) / 1e6 : null; minimumHoldingUsd = b > 0n ? Number(b) / 1e6 : null; }
  const [mode, threshold, minimumHolding, vesting, rewardAsset, count] = await Promise.all([v.mode(), v.threshold(), v.minimumHolding(), v.vesting(), v.rewardAsset(), v.roundCount()]);
  let pending = 0n; try { pending = (await new Contract(d.hook, ['function ledgers(address) view returns(uint256[5] owed,uint128[5] paid)'], provider).ledgers(token)).owed[0]; } catch { pending = 0n; }
  const rounds = [];
  for (let i = Number(count) - 1; i >= 0 && rounds.length < 5; i--) { const r = await v.rounds(i); rounds.push({ round: i, asset: r.asset, total: r.total, claimed: r.claimed, recipients: Number(r.recipients), postedAt: Number(r.postedAt), vesting: Number(r.vesting) }); }
  return { vault: l.creatorVault, mode: ['holders', 'paired', 'buyback'][Number(mode)], threshold, minimumHolding, thresholdUsd, minimumHoldingUsd, vesting: Number(vesting), rewardAsset, gathered: (await v.available(l.quote)) + pending, rounds, roundCount: Number(count) };
}

const IDENTITY_ABI = ['function IDENTITY_ALLOCATION_VERSION() view returns(uint256)', 'function rowCount() view returns(uint256)', 'function row(uint256) view returns(string label,address wallet,uint16 share)',
  'function accounted(address) view returns(uint256)', 'function claimable(address,uint256) view returns(uint256)', 'function claim(address asset,uint256 i) returns(bool)'];
/** A V2 token's wallet, X and website allocations, if its creator vault is one: each row and what it can claim now. */
export async function identityAllocationState({ provider, net, token }) {
  const d = v2Deployment(net); if (!d?.hook) return null;
  const l = await new Contract(d.hook, V2_HOOK_FEES_ABI, provider).launchOf(token);
  if (!l.creatorVault || l.creatorVault === ZeroAddress || (await provider.getCode(l.creatorVault)) === '0x') return null;
  const c = new Contract(l.creatorVault, IDENTITY_ABI, provider);
  try { if ((await c.IDENTITY_ALLOCATION_VERSION()) !== 1n) return null; } catch { return null; }
  const n = Number(await c.rowCount()), asset = l.quote, rows = [];
  for (let i = 0; i < n; i++) { const r = await c.row(i), [kind, ...rest] = String(r.label).split(':'); rows.push({ index: i, kind, target: rest.join(':') || null, wallet: r.wallet === ZeroAddress ? null : r.wallet, bps: Number(r.share) }); }
  const held = asset === ZeroAddress ? await provider.getBalance(l.creatorVault) : await new Contract(asset, ERC20, provider).balanceOf(l.creatorVault);
  const accounted = await c.accounted(asset), fresh = held > accounted ? held - accounted : 0n;
  let assigned = 0n;
  for (const [i, r] of rows.entries()) { const part = i + 1 === rows.length ? fresh - assigned : fresh * BigInt(r.bps) / 10000n; assigned += part; r.claimable = (await c.claimable(asset, i)) + part; }
  return { vault: l.creatorVault, asset, rows };
}

/** Collects the token's fees from the pool and pays one allocation row (a wallet, or a verified X account or website). */
export async function claimIdentityRow(w, { token, index } = {}) {
  await w.checkNetwork();
  const d = v2Deployment(w.net); if (!d?.hook) throw new Error(`There is no V2 launchpad on ${w.net.name}.`);
  const hook = new Contract(d.hook, V2_HOOK_FEES_ABI, w.provider), l = await hook.launchOf(token), c = new Contract(l.creatorVault, IDENTITY_ABI, w.provider);
  const r = await c.row(Number(index));
  if (r.wallet === ZeroAddress) throw new Error('This share is held until its owner verifies. Nothing was sent.');
  const calls = [{ to: d.hook, data: hook.interface.encodeFunctionData('withdrawFees', [token]), label: 'Collect the token\'s fees from the pool…' },
    { to: l.creatorVault, data: c.interface.encodeFunctionData('claim', [l.quote, Number(index)]), label: 'Pay this allocation its share…' }];
  const res = await w.sendCalls(calls, 'Collect fees and pay out this allocation.');
  return { hash: res.tx.hash, message: `Paid out to ${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}.` };
}

/** Collects the token's fees from the pool (permissionless) and pays one split wallet its share, in one go when the wallet batches. */
export async function claimCreatorSplit(w, { token, wallet } = {}) {
  await w.checkNetwork();
  const d = v2Deployment(w.net); if (!d?.hook) throw new Error(`There is no V2 launchpad on ${w.net.name}.`);
  if (!isAddress(token) || !isAddress(wallet)) throw new Error('Choose a token and a split wallet.');
  const hook = new Contract(d.hook, V2_HOOK_FEES_ABI, w.provider), l = await hook.launchOf(token);
  const rows = await readSplit(w.provider, l.creatorVault);
  if (!rows?.some(r => r.wallet.toLowerCase() === wallet.toLowerCase())) throw new Error('That wallet is not in this token\'s creator split.');
  const split = new Contract(l.creatorVault, SPLIT_ABI, w.provider);
  const calls = [{ to: d.hook, data: hook.interface.encodeFunctionData('withdrawFees', [token]), label: 'Collect the token\'s fees from the pool…' },
    { to: l.creatorVault, data: split.interface.encodeFunctionData('claim', [l.quote, getAddress(wallet)]), label: `Pay ${wallet.slice(0, 6)}…${wallet.slice(-4)} its share…` }];
  const r = await w.sendCalls(calls, 'Collect fees and pay out this share.');
  return { hash: r.tx.hash, message: `Paid out to ${wallet.slice(0, 6)}…${wallet.slice(-4)}. The split sends each wallet only its own share.` };
}
/** The split contract for these exact wallets and shares: one this browser deployed before (checked on chain), else a new one. */
async function creatorSplit(w, { wallets, shares }) {
  const art = w.config.contracts?.creatorAllocation;
  if (!art?.bytecode) throw new Error('Creator splits are not available on this server yet. Use one creator wallet. Nothing was submitted.');
  const key = `elpida:v2:split:${w.net.chainId}:${wallets.map((a, i) => `${a.toLowerCase()}=${shares[i]}`).join(',')}`, saved = read(key)?.address;
  if (saved && await hasCode(w.provider, saved)) {
    const c = new Contract(saved, SPLIT_ABI, w.provider);
    try { const same = (await Promise.all(wallets.map(async (a, i) => (await c.recipients(i)).toLowerCase() === a.toLowerCase() && Number(await c.shares(i)) === shares[i]))).every(Boolean); if (same) { w.onProgress('Reusing your creator split contract from an earlier attempt…'); return saved; } } catch { /* not ours: deploy a new one */ }
  }
  const deployed = await new ContractFactory(art.abi, art.bytecode, w.signer).deploy(wallets, shares);
  const r = await w.wait(Promise.resolve(deployed.deploymentTransaction()), `Deploy your creator split (${wallets.length} wallets). It has no owner and cannot be changed…`);
  await walletCaughtUp(w, r?.tx?.nonce);
  const address = await deployed.getAddress();
  if (!await hasCode(w.provider, address, { wait: true })) throw new Error('The creator split contract is not visible on the network yet. Try again; nothing else was submitted.');
  write(key, { address });
  return address;
}

async function step(w, pending, message) { const r = await w.wait(pending, message); await walletCaughtUp(w, r?.tx?.nonce); return r; }
