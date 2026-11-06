// Model 11 in the browser (phase 4): deploy the labelled test launchpad, launch, buy and sell. A v4 launch has no curve
// contract: it lives in one Uniswap v4 pool behind ElpidaV4Hook, so trades go through ElpidaV4Router (one approval of
// the router for an ERC-20 input, no Permit2). NOT AUDITED: test networks with Uniswap v4 only (Base Sepolia and
// Ethereum Sepolia). Every function takes the connected TestnetWallet `w` (provider, signer, net, oracle, wait).
import { Contract, ContractFactory, AbiCoder, concat, keccak256, getBytes, getAddress, zeroPadValue, toBeHex, parseUnits, formatUnits, isAddress, ZeroAddress } from '/vendor/ethers.js';
import { V4_MODEL, V4_HOOK_FLAGS, V4_FLAG_MASK, V4_FEE, V4_NETWORKS, firstBuyOut } from '/v4-model.mjs';
import { TESTNET_START_FDV_USD, usdQuoteTemplate } from '/curve-model.mjs';
import { normalizeMetadata } from './metadata.mjs';
import { prepareUploadProof } from './upload-proof.mjs';
import { approvalFor } from './one-confirmation.mjs';

export const V4_ROUTER_ABI = ['function buy(address token,uint256 quoteIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns(uint256)', 'function sell(address token,uint256 tokensIn,uint256 minQuoteOut,address recipient,uint256 deadline) returns(uint256)', 'function quote(address token,bool isBuy,uint256 amountIn) returns(uint256 paid,uint256 out)', 'function hook() view returns(address)', 'function poolManager() view returns(address)', 'function ROUTER_VERSION() view returns(uint256)'];
export const V4_FACTORY_ABI = ['function launchWithPayment(string name,string symbol,address asset,uint256 firstBuy,uint256 minOut,address reward,string uri,bool inUsdc) payable returns(address token,uint256 bought)', 'function launchFee() view returns(uint256)', 'function nativeVirtualQuote() view returns(uint256)', 'function approvedQuotes(address) view returns(uint256)', 'function treasury() view returns(address)', 'function hook() view returns(address)', 'function feeUsdc() view returns(address)', 'function usdFeed() view returns(address)', 'function requiresMetadata() view returns(bool)', 'function MODEL_VERSION() view returns(uint256)', 'event Launched(address indexed creator,address indexed token,address indexed quote,uint256 firstBuy,uint256 bought)'];
const HOOK_ABI = ['function currentFeeBps(address) view returns(uint256)', 'function withdrawFees(address)', 'function factory() view returns(address)', 'function protocolTreasury() view returns(address)'];
const ERC20 = ['function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'];
const LABEL = 'Model 11 test launchpad (Uniswap v4 hook). Not audited; test networks only.';
const savedKey = chainId => `elpida:v4:deployment:${chainId}`;
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

/** True for a token launched on Model 11 (the public index tags its rows with the deployment model). */
export const isV4Token = item => item?.deploymentModel === V4_MODEL || item?.model === V4_MODEL;
/** Whether this network has Uniswap v4 for Model 11 (networks.mjs `v4`). */
export const v4Available = net => !!net?.v4?.poolManager && V4_NETWORKS.includes(net.key) && !net.mainnet;
/** The network's Model 11 launchpad: the team deployment pinned in networks.mjs, else one this browser deployed. */
export function v4Deployment(net) {
  if (!v4Available(net)) return null;
  if (net.v4.shared?.factory) return { ...net.v4.shared, poolManager: net.v4.poolManager, pinned: true };
  const saved = read(savedKey(net.chainId));
  return saved?.factory && saved.poolManager?.toLowerCase() === net.v4.poolManager.toLowerCase() ? { ...saved, pinned: false } : null;
}

/**
 * Finds a CREATE2 salt whose address carries exactly the hook's permission bits in its low 14 bits (one address in
 * 16,384 on average). Runs in slices so the page stays responsive.
 */
export async function mineHookSalt(deployer, initCode, { flags = V4_HOOK_FLAGS, onProgress = () => {}, maxTries = 4_000_000, slice = 4000 } = {}) {
  const codeHash = getBytes(keccak256(initCode)), buf = new Uint8Array(85);
  buf.set(getBytes(concat(['0xff', deployer])), 0); buf.set(codeHash, 53);
  for (let i = 0; i < maxTries; i++) {
    const salt = zeroPadValue(toBeHex(i), 32); buf.set(getBytes(salt), 21);
    const address = BigInt('0x' + keccak256(buf).slice(26));
    if ((address & V4_FLAG_MASK) === flags) return { salt, address: getAddress('0x' + address.toString(16).padStart(40, '0')), tries: i + 1 };
    if (i % slice === slice - 1) { onProgress(i + 1); await new Promise(r => setTimeout(r, 0)); }
  }
  throw new Error('No hook address found. Nothing was deployed for the hook.');
}

async function artifacts() {
  const response = await fetch('/api/v4-artifacts');
  if (!response.ok) throw new Error('The Model 11 contracts are unavailable. Nothing was deployed.');
  return response.json();
}

/**
 * Deploys the labelled Model 11 test launchpad with the connected wallet as its treasury: a CREATE2 deployer, the
 * factory ($50 starting FDV, as every test launchpad), the hook at a mined address, then pricing, the USDC pair and the
 * router. Each step is saved, so a rejected or failed step resumes where it stopped.
 */
export async function deployV4(w, body = {}) {
  await w.checkNetwork();
  const net = w.net;
  if (!v4Available(net)) throw new Error(`${net.name} has no Uniswap v4 for Model 11. Use Base Sepolia or Ethereum Sepolia.`);
  if (net.v4.shared?.factory) throw new Error(`The ${net.name} Model 11 test launchpad is already pinned. Use it for launches.`);
  if (v4Deployment(net)) throw new Error(`A ${net.name} Model 11 test launchpad was already deployed from this browser (factory ${v4Deployment(net).factory}). Send its addresses to be pinned; nothing was deployed.`);
  const entered = String(body.treasury ?? '').trim();
  if (entered && (!isAddress(entered) || getAddress(entered) !== getAddress(w.address))) throw new Error('The Model 11 test launchpad uses the connected wallet as its treasury. Leave the treasury empty. Nothing was deployed.');
  if (!w.oracle?.available) throw new Error(`Verified USD pricing is not configured for ${net.name}. Nothing was deployed.`);
  await w.oraclePrice();
  const poolManager = getAddress(net.v4.poolManager);
  if (await w.provider.getCode(poolManager) === '0x') throw new Error(`Uniswap's v4 PoolManager ${poolManager} has no code on ${net.name}. Nothing was deployed.`);
  if (await w.provider.getBalance(w.address) === 0n) throw new Error(`Get ${net.nativeCurrency.symbol} on ${net.name} from a faucet to pay deployment gas.`);
  const a = await artifacts(), progress = read(savedKey(net.chainId) + ':progress') ?? {};
  const save = () => write(savedKey(net.chainId) + ':progress', progress);
  const fresh = async (key, check) => progress[key] && await w.provider.getCode(progress[key]) !== '0x' && (!check || await check(progress[key]));
  const deploy = async (art, args, message) => { w.onProgress(message); const c = await new ContractFactory(art.abi, art.bytecode, w.signer).deploy(...args); await c.waitForDeployment(); return { address: await c.getAddress(), receipt: await c.deploymentTransaction().wait() }; };
  if (!await fresh('create2')) { progress.create2 = (await deploy(a.create2, [], `Step 1 of 6: confirm the CREATE2 deployer for the hook (${LABEL})…`)).address; save(); }
  if (!await fresh('factory', async f => (await new Contract(f, V4_FACTORY_ABI, w.provider).treasury()).toLowerCase() === w.address.toLowerCase())) {
    const d = await deploy(a.factory, [w.address, TESTNET_START_FDV_USD, true], `Step 2 of 6: confirm the Model 11 factory ($${TESTNET_START_FDV_USD} starting FDV, token details required)…`);
    progress.factory = d.address; progress.block = d.receipt.blockNumber; progress.hook = null; save();
  }
  const factory = new Contract(progress.factory, [...V4_FACTORY_ABI, 'function setHook(address)', 'function configureUsdPricing(address,uint256,address)', 'function approveQuote(address,uint256)'], w.signer);
  if (!progress.hook || await w.provider.getCode(progress.hook) === '0x') {
    const initCode = concat([a.hook.bytecode, AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address'], [poolManager, progress.factory, w.address])]);
    w.onProgress('Step 3 of 6: finding the hook address (its last bits are its Uniswap v4 permissions)…');
    const mined = await mineHookSalt(progress.create2, initCode, { onProgress: n => w.onProgress(`Step 3 of 6: finding the hook address… ${n.toLocaleString()} tried`) });
    const deployer = new Contract(progress.create2, ['function deploy(bytes,bytes32) returns(address)'], w.signer);
    await w.wait(deployer.deploy(initCode, mined.salt), `Step 3 of 6: confirm the hook deployment at ${mined.address}…`);
    if (await w.provider.getCode(mined.address) === '0x') throw new Error('The hook was not deployed at its mined address. Retry; finished steps are kept.');
    progress.hook = mined.address; save();
  }
  const hook = new Contract(progress.hook, HOOK_ABI, w.provider);
  if ((await hook.factory()).toLowerCase() !== progress.factory.toLowerCase() || (await hook.protocolTreasury()).toLowerCase() !== w.address.toLowerCase()) throw new Error('The hook is wired to another factory or treasury. Nothing more was sent.');
  if ((await factory.hook()) === ZeroAddress) await w.wait(factory.setHook(progress.hook), 'Step 4 of 6: confirm connecting the hook to the factory…');
  if ((await factory.usdFeed()) === ZeroAddress) await w.wait(factory.configureUsdPricing(w.oracle.feed, w.oracle.maxAge, w.oracle.usdc ?? ZeroAddress), 'Step 5 of 6: confirm verified USD pricing (the $10 launch fee and the starting FDV)…');
  const usdc = w.oracle.usdc && w.oracle.usdc !== ZeroAddress ? getAddress(w.oracle.usdc) : null;
  if (usdc && (await factory.approvedQuotes(usdc)) === 0n) {
    const decimals = Number(await new Contract(usdc, ERC20, w.provider).decimals());
    await w.wait(factory.approveQuote(usdc, usdQuoteTemplate(TESTNET_START_FDV_USD, decimals)), 'Step 5 of 6: confirm the USDC pair…');
  }
  if (!await fresh('router', async r => { const c = new Contract(r, V4_ROUTER_ABI, w.provider); return (await c.hook()).toLowerCase() === progress.hook.toLowerCase(); })) { progress.router = (await deploy(a.router, [poolManager, progress.hook], 'Step 6 of 6: confirm the Model 11 router (buys and sells)…')).address; save(); }
  const record = { factory: progress.factory, hook: progress.hook, router: progress.router, create2: progress.create2, block: progress.block, poolManager, treasury: w.address, model: V4_MODEL, deployedAt: Date.now() };
  if (!write(savedKey(net.chainId), record)) throw new Error(`Deployed, but this browser blocks storage. Save factory ${record.factory}, hook ${record.hook}, router ${record.router} (block ${record.block}).`);
  try { localStorage.removeItem(savedKey(net.chainId) + ':progress'); } catch { /* kept for a retry */ }
  return { record, message: `The ${net.name} Model 11 test launchpad is deployed: factory ${record.factory}, hook ${record.hook}, router ${record.router}, from block ${record.block}. Send these to be pinned in networks.mjs (v4.shared) so the site lists its tokens.` };
}

async function stageMetadata(w, name, symbol, body) {
  const details = normalizeMetadata(body);
  w.onProgress('Preparing public token details for the launch transaction…');
  const payload = JSON.stringify({ network: w.net.key, name, symbol, ...details }), proof = await prepareUploadProof(payload);
  const response = await fetch('/api/metadata/stage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Elpida-Token': w.config.csrf, ...proof }, body: payload });
  const published = await response.json();
  if (!response.ok) throw new Error(published.error ?? 'Metadata publishing failed.');
  if (!/^ipfs:\/\//.test(published.uri) || !['public-ipfs', 'elpida-hosted'].includes(published.storage)) throw new Error('Token details were not staged safely. No launch was submitted.');
  return published;
}

const slippageBps = value => { const p = Number(value ?? '1'); if (!Number.isFinite(p) || p < 0.1 || p > 5) throw new Error('Slippage must be between 0.1% and 5%.'); return BigInt(Math.round(p * 100)); };

/** Tokens a creator's first buy would get at launch (exact for a first buy inside the sale range). */
export async function v4LaunchQuote(w, { firstBuy = '0', pair = 'native' } = {}) {
  const d = v4Deployment(w.net); if (!d) throw new Error('No Model 11 launchpad on this network.');
  const factory = new Contract(d.factory, V4_FACTORY_ABI, w.provider), usdc = pair === 'usdc' ? await factory.feeUsdc() : null;
  const decimals = usdc ? Number(await new Contract(usdc, ERC20, w.provider).decimals()) : 18;
  const vq = usdc ? await factory.approvedQuotes(usdc) : await factory.nativeVirtualQuote(), input = parseUnits(String(firstBuy || '0'), decimals);
  return { tokens: formatUnits(firstBuyOut(vq, input), 18), launchFee: formatUnits(await factory.launchFee(), 18) };
}

/** Launches on Model 11: the token, its v4 pool and its locked positions in one transaction, details on-chain. */
export async function launchV4(w, body) {
  await w.checkNetwork();
  const d = v4Deployment(w.net); if (!d) throw new Error(`There is no Model 11 launchpad on ${w.net.name} yet. Nothing was submitted.`);
  const factory = new Contract(d.factory, V4_FACTORY_ABI, w.signer);
  if (Number(await factory.MODEL_VERSION()) !== 11 || (await factory.hook()).toLowerCase() !== d.hook.toLowerCase()) throw new Error('The Model 11 launchpad does not match its record. Nothing was submitted.');
  const name = String(body.name ?? '').trim(), symbol = String(body.symbol ?? '').trim().toUpperCase();
  if (!name || name.length > 40 || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Check the token name and symbol.');
  const pair = body.pair ?? 'native';
  if (!['native', 'usdc'].includes(pair)) throw new Error('Model 11 test launches pair with the native coin or USDC.');
  const reward = body.reward || w.address;
  if (!isAddress(reward) || reward === ZeroAddress) throw new Error('Enter a valid creator reward wallet.');
  const asset = pair === 'usdc' ? await factory.feeUsdc() : ZeroAddress;
  if (pair === 'usdc' && (asset === ZeroAddress || (await factory.approvedQuotes(asset)) === 0n)) throw new Error('USDC is not approved on this Model 11 launchpad. Launch with the native coin.');
  const quote = asset === ZeroAddress ? null : new Contract(asset, ERC20, w.signer), decimals = quote ? Number(await quote.decimals()) : 18;
  const firstBuy = parseUnits(String(body.firstBuy || '0'), decimals);
  const vq = quote ? await factory.approvedQuotes(asset) : await factory.nativeVirtualQuote();
  const minOut = firstBuyOut(vq, firstBuy) * (10000n - slippageBps(body.slippage)) / 10000n;
  const fee = await factory.launchFee(), value = (fee * 101n + 99n) / 100n + (quote ? 0n : firstBuy);
  if (await w.provider.getBalance(w.address) < value) throw new Error(`You need ${formatUnits(value, 18)} ${w.net.nativeCurrency.symbol} for the $10 launch fee${quote ? '' : ' and your first buy'}, plus gas.`);
  if (quote && firstBuy > 0n) {
    if (await quote.balanceOf(w.address) < firstBuy) throw new Error(`You need ${formatUnits(firstBuy, decimals)} USDC for the first buy.`);
    if (await quote.allowance(w.address, d.factory) < firstBuy) await w.wait(quote.approve(d.factory, firstBuy), 'Approve exactly the first buy in USDC…');
  }
  const published = await stageMetadata(w, name, symbol, body);
  await w.checkNetwork();
  const result = await w.wait(factory.launchWithPayment(name, symbol, asset, firstBuy, minOut, reward, published.uri, false, { value }), `Confirm the Model 11 launch (${LABEL})…`);
  const event = result.receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
  return { hash: result.tx.hash, token: event?.args.token, metadataSaved: true, metadataPublished: true, metadataStorage: published.storage, message: `Your token is live on ${w.net.name}, Model 11 (Uniswap v4, liquidity locked from launch). ${d.pinned ? '' : 'This launchpad is not pinned yet, so the site lists the token once it is.'}`.trim() };
}

function routerFor(w, item, runner) {
  const d = v4Deployment(w.net);
  if (!d?.router) throw new Error('This network has no Model 11 router. Trading is unavailable.');
  if (item.factory && item.factory.toLowerCase() !== d.factory.toLowerCase()) throw new Error('This token belongs to another Model 11 launchpad.');
  return { router: new Contract(d.router, V4_ROUTER_ABI, runner), hook: new Contract(d.hook, HOOK_ABI, runner), d };
}
const quoteDecimals = item => item.pair === 'native' ? 18 : Number(item.quoteDecimals ?? 18);

/** The exact result of a buy or sell now, fees included (the router runs the swap and undoes it). */
export async function v4Quote(w, item, side, amount) {
  const { router, hook } = routerFor(w, item, w.provider), d = quoteDecimals(item), buy = side === 'buy';
  const input = parseUnits(String(amount), buy ? d : 18);
  if (input <= 0n) throw new Error('Enter a positive amount.');
  const [[, out], bps] = await Promise.all([router.quote.staticCall(item.address, buy, input), hook.currentFeeBps(item.address)]);
  const feeBps = Number(bps), fee = buy ? input * bps / 10000n : (out * bps + 10000n - bps - 1n) / (10000n - bps);
  return { out: formatUnits(out, buy ? 18 : d), fee: formatUnits(fee, d), feeBps, launchedAt: item.launchedAt, antiSnipeActive: !item.graduated && feeBps > V4_FEE.base, venue: 'Uniswap v4' };
}

/** A buy or sell through the Model 11 router: an approval only when an ERC-20 input needs one, then the trade. */
export async function v4Trade(w, item, side, body) {
  await w.checkNetwork();
  const { router } = routerFor(w, item, w.signer), d = quoteDecimals(item), buy = side === 'buy', native = item.pair === 'native';
  const bps = slippageBps(body.slippage), input = parseUnits(String(body.amount), buy ? d : 18);
  if (input <= 0n) throw new Error('Enter a positive amount.');
  const [, out] = await router.quote.staticCall(item.address, buy, input);
  const minimum = out * (10000n - bps) / 10000n, deadline = BigInt((await w.provider.getBlock('latest')).timestamp + 600);
  const steps = [];
  if (!buy || !native) {
    const payment = new Contract(buy ? item.quoteAddress : item.address, ERC20, w.signer);
    if (await payment.balanceOf(w.address) < input) throw new Error(`Not enough ${buy ? item.quoteSymbol : item.symbol} for this trade.`);
    const approval = approvalFor({ allowance: await payment.allowance(w.address, router.target), input, sellingLaunchedToken: !buy, symbol: item.symbol });
    if (approval) steps.push({ to: payment.target, data: payment.interface.encodeFunctionData('approve', [router.target, approval.amount]), label: approval.label });
  }
  steps.push({ to: router.target, data: router.interface.encodeFunctionData(buy ? 'buy' : 'sell', [item.address, input, minimum, w.address, deadline]), value: buy && native ? input : 0n, label: 'Confirm the trade in your wallet…' });
  return w.sendCalls(steps, 'Confirm the trade.');
}

/** Pays a launch's fees to its fixed recipients (the creator vault and the treasury). Anyone may call it. */
export async function v4WithdrawFees(w, item) {
  await w.checkNetwork();
  const { hook } = routerFor(w, item, w.signer);
  return w.wait(hook.withdrawFees(item.address), 'Confirm paying the fees to their fixed recipients…');
}

/** The connected wallet's balance of a Model 11 token; everything else comes from the public index. */
export async function v4TokenState(w, item) {
  const balance = await new Contract(item.address, ERC20, w.provider).balanceOf(w.address);
  return { ...item, balance: formatUnits(balance, 18), venue: 'Uniswap v4', liquidityLocked: true };
}
