// Multi-chain fork check: runs Elpida's full EVM lifecycle against a chain's REAL graduation DEX and price feed, on a
// local fork. Nothing is signed with your keys and nothing is sent to the real chain.
//   npm run test:chain-fork -- ethereum-sepolia
//   npm run test:chain-fork -- bnb-testnet
//   npm run test:chain-fork -- base-sepolia
//   npm run test:chain-fork -- robinhood-mainnet   (fork only: Robinhood's testnet has no DEX or price feed)
// Optional env: ELPIDA_FORK_RPC_<NETWORK> (e.g. ELPIDA_FORK_RPC_BNB_TESTNET) to use your own RPC; ELPIDA_FORK_BLOCK.
// Writes backups/chain-fork/<network>.json with every check, the gas each step used, and what to collect from faucets.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, Interface, ZeroAddress, formatEther, formatUnits, parseEther } from 'ethers';
import { swapCalldata } from '../packages/core/dex-router.mjs';
import { v3PoolAbi } from '../packages/core/uniswap.mjs';
import { EvmIndexer } from '../packages/indexer/evm-indexer.mjs';

const MANAGER_ABI = ['function factory() view returns(address)', 'function WETH9() view returns(address)', 'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns(address)'];
const V3_FACTORY_ABI = ['function feeAmountTickSpacing(uint24) view returns(int24)', 'function getPool(address,address,uint24) view returns(address)'];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160,uint32,uint256)'];
const POOL_ABI = ['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)'];
const ERC20_ABI = ['function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'];
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Runs the lifecycle. `dex` is a testnetDexes entry; `feed` the chain's native/USD Chainlink feed. `art(name)` returns a
 * compiled Elpida artifact. Throws on the first failed check; returns { checks, gas, addresses } otherwise.
 */
export async function runChainLifecycle({ provider, signer, attacker, dex, feed, feedDescription = null, maxAge = 3900, startFdvUsd = 50, grace = 86400, art, log = () => {} }) {
  const checks = [], gas = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) throw new Error(`Check failed: ${name}${detail ? ' (' + detail + ')' : ''}`); };
  const send = async (step, pending) => { let r; try { r = await (await pending).wait(); } catch (error) { error.step ??= step; throw error; } if (r.status !== 1) throw new Error(`${step} reverted`); gas.push({ step, gas: r.gasUsed.toString() }); return r; };
  const deploy = async (name, ...args) => { const a = art(name), c = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(...args); const r = await c.deploymentTransaction().wait(); gas.push({ step: `deploy ${name}`, gas: r.gasUsed.toString() }); return c; };
  const advance = async seconds => { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); };
  const me = await signer.getAddress(), version = dex.routerVersion ?? 2;

  // 1. The DEX is what the config says it is.
  const manager = new Contract(dex.manager, MANAGER_ABI, signer), v3 = new Contract(dex.factory, V3_FACTORY_ABI, provider);
  check(`${dex.name}: position manager belongs to the configured factory`, eq(await manager.factory(), dex.factory));
  const weth = await manager.WETH9();
  check('wrapped native coin matches the config (manager.WETH9())', eq(weth, dex.weth), weth);
  check(`${dex.fee / 10000}% fee tier exists with tick spacing 200`, (await v3.feeAmountTickSpacing(dex.fee)) === 200n);
  if (feedDescription) {
    const described = await new Contract(feed, ['function description() view returns(string)'], provider).description();
    check(`price feed is ${feedDescription}`, described === feedDescription, described);
  }

  // 2. Our contracts, deployed exactly as the app deploys them ($50 start on testnets, $5,000 on a mainnet fork; 24 h grace).
  const adapter = await deploy('ElpidaV3MigrationAdapter', dex.manager, weth, dex.fee);
  const factory = await deploy('ElpidaAtomicDexFactory', me, adapter.target, startFdvUsd, grace);
  const deployBlock = (await factory.deploymentTransaction().wait()).blockNumber;
  await send('configure USD pricing', factory.configureUsdPricing(feed, maxAge, ZeroAddress));
  const fee = await factory.launchFee();
  check('the $10 launch fee is priced by the live feed', fee > 0n, `${formatEther(fee)} native`);

  const launchToken = async (name, symbol) => {
    const firstBuy = (await factory.nativeVirtualQuote()) / 100n;
    // The mainnet factory requires token details in the launch transaction (an ipfs:// URI).
    const r = await send(`launch ${symbol}`, factory.launchWithMetadata(name, symbol, firstBuy, 0, me, 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', { value: fee + firstBuy }));
    const ev = r.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
    return { curve: new Contract(ev.args.curve, art('ElpidaDexCurve').abi, signer), token: new Contract(ev.args.token, art('ElpidaToken').abi, signer) };
  };
  const finish = async (l, label) => {
    const launched = Number(await l.curve.launchedAt()), now = (await provider.getBlock('latest')).timestamp;
    if (now < launched + 61) await advance(launched + 61 - now);
    const needed = await l.curve.completionQuote();
    await send(`final buy + atomic graduation (${label})`, l.curve.buy(needed, 0, { value: needed }));
    return l.curve.pool();
  };

  // 3. Launch, complete, graduate in the final buy.
  const a = await launchToken('Fork Check A', 'FCA');
  const poolA = await finish(a, 'A');
  check('final buy graduated atomically into the DEX', poolA !== ZeroAddress && await a.curve.complete(), poolA);
  const locker = new Contract(await a.curve.locker(), art('ElpidaV3FeeLocker').abi, signer);
  check('liquidity position is held by the permanent locker', await locker.locked());

  // 4. Trade on the DEX through this chain's router layout.
  const router = dex.router, quoter = new Contract(dex.quoter, QUOTER_ABI, provider);
  const quote = async (tokenIn, tokenOut, amountIn) => (await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: dex.fee, sqrtPriceLimitX96: 0 }))[0];
  const deadline = BigInt((await provider.getBlock('latest')).timestamp + 600);
  const buyIn = fee; // about $10 of native
  const buyOut = await quote(weth, a.token.target, buyIn);
  const before = await a.token.balanceOf(me);
  await send('DEX buy (native in)', signer.sendTransaction({ to: router, value: buyIn, data: swapCalldata(Interface, version, router, { tokenIn: weth, tokenOut: a.token.target, fee: dex.fee, recipient: me, amountIn: buyIn, amountOutMinimum: buyOut * 95n / 100n }, { deadline }) }));
  const bought = (await a.token.balanceOf(me)) - before;
  check(`DEX buy through router v${version} delivered tokens`, bought >= buyOut * 95n / 100n, `${formatEther(bought)} tokens`);
  const sellIn = bought / 2n, sellOut = await quote(a.token.target, weth, sellIn);
  await send('approve DEX sell', a.token.approve(router, sellIn));
  const nativeBefore = await provider.getBalance(me);
  const sold = await send('DEX sell (native out)', signer.sendTransaction({ to: router, data: swapCalldata(Interface, version, router, { tokenIn: a.token.target, tokenOut: weth, fee: dex.fee, recipient: me, amountIn: sellIn, amountOutMinimum: sellOut * 95n / 100n }, { deadline, unwrapTo: me }) }));
  const received = (await provider.getBalance(me)) - nativeBefore + sold.gasUsed * sold.gasPrice;
  check('DEX sell unwrapped native coin to the seller', received >= sellOut * 95n / 100n, `${formatEther(received)} native`);

  // 5. Pool fees reach the fixed recipients.
  await send('collect pool fees', locker.collectFees());
  const splitter = new Contract(await locker.splitter(), art('ElpidaFeeSplitter').abi, signer);
  const owedWeth = await splitter.claimable(weth, me), owedToken = await splitter.claimable(a.token.target, me);
  check('pool fees were credited from both trades', owedWeth > 0n && owedToken > 0n, `${formatEther(owedWeth)} wrapped native, ${formatEther(owedToken)} tokens`);
  const wethCoin = new Contract(weth, ERC20_ABI, provider), wethBefore = await wethCoin.balanceOf(me);
  await send('claim pool fees (wrapped native)', splitter.claim(weth, me));
  await send('claim pool fees (token)', splitter.claim(a.token.target, me));
  check('claims paid out and cleared', (await wethCoin.balanceOf(me)) - wethBefore === owedWeth && await splitter.claimable(weth, me) === 0n && await splitter.claimable(a.token.target, me) === 0n);
  await send('curve fee withdrawal', a.curve.withdrawFees());

  // 6. Someone creates the pool first at a wrong price: graduation must rebalance it (exercises the swap callback).
  const b = await launchToken('Fork Check B', 'FCB');
  const [t0, t1] = BigInt(b.token.target) < BigInt(weth) ? [b.token.target, weth] : [weth, b.token.target];
  await send('griefer pre-creates the pool at a wrong price', manager.connect(attacker).createAndInitializePoolIfNecessary(t0, t1, dex.fee, 1n << 96n));
  const poolB = await finish(b, 'B, pre-created pool');
  const [price] = await new Contract(poolB, POOL_ABI, provider).slot0();
  check('graduation repriced the pre-created pool and locked liquidity', poolB !== ZeroAddress && price !== (1n << 96n) && await new Contract(await b.curve.locker(), art('ElpidaV3FeeLocker').abi, provider).locked(), `slot0 price ${price}`);

  // 7. Elpida's own indexer reads this DEX: trades on the graduated pool appear with the right sides.
  const contracts = { factory: art('ElpidaAtomicDexFactory'), curve: art('ElpidaDexCurve'), token: art('ElpidaToken'), pool: art('ElpidaLockedPool'), dexPool: { abi: v3PoolAbi() }, locker: art('ElpidaV3FeeLocker'), splitter: art('ElpidaFeeSplitter') };
  const index = new EvmIndexer({ provider, factory: factory.target, contracts, fromBlock: deployBlock, chainId: Number((await provider.getNetwork()).chainId) });
  try {
    await index.sync();
    const dexTrades = index.trades(a.token.target.toLowerCase()).filter(t => t.venue === 'dexPool');
    check('indexer recorded the DEX buy and sell with the right sides', dexTrades.length === 2 && dexTrades.some(t => t.side === 'buy') && dexTrades.some(t => t.side === 'sell'), dexTrades.map(t => t.side).join(', '));
    check('indexer shows both tokens as graduated into the DEX', index.snapshot(a.token.target)?.graduated === true && index.snapshot(b.token.target)?.graduated === true);
  } finally { await index.close(); }

  return { checks, gas, addresses: { adapter: adapter.target, factory: factory.target, weth, poolA, poolB } };
}

async function main() {
  const key = process.argv[2];
  const [{ network }, { testnets }, { testnetDexes }, { usdOracles }, { compileContracts }, { BrowserProvider }] = await Promise.all([
    import('hardhat'), import('../packages/core/networks.mjs'), import('../packages/core/uniswap.mjs'), import('../packages/core/usd-oracles.mjs'), import('./compile.mjs'), import('ethers'),
  ]);
  const only = FORK_ONLY[key];
  const net = only?.net ?? testnets.find(n => n.key === key), dex = only?.dex ?? testnetDexes[key], oracle = only?.oracle ?? usdOracles()[key];
  assert.ok(net && dex && oracle?.feed, `Usage: npm run test:chain-fork -- <${[...Object.keys(testnetDexes), ...Object.keys(FORK_ONLY)].join('|')}>`);
  const override = process.env[`ELPIDA_FORK_RPC_${key.toUpperCase().replace(/-/g, '_')}`];
  const candidates = override ? [override] : [...new Set([net.rpcUrl, ...(FORK_RPC_FALLBACKS[key] ?? [])])];
  const compiled = compileContracts(), art = n => compiled[`contracts/evm/src/${n}.sol`][n];
  const report = { scope: only ? 'LOCAL FORK ONLY: mainnet state is read, nothing is sent and no funds are used' : 'LOCAL FORK ONLY', network: key, chainId: net.chainId, dex: dex.name, routerVersion: dex.routerVersion ?? 2, feed: oracle.feed };
  let lastError = null;
  try {
    // Forking reads chain state at a past block. Pruned nodes (common on BNB, where blocks are under a second) drop that
    // state within seconds, so each RPC is checked first, and a run that loses state mid-way retries on the next one.
    for (let attempt = 0; attempt < FORK_ATTEMPTS && !report.result; attempt++) {
      const pick = await chooseForkRpc(candidates, net.chainId, attempt);
      if (!pick) { lastError = new Error(`None of these RPCs answered with recent ${net.name} state: ${candidates.map(u => new URL(u).host).join(', ')}`); break; }
      const { rpc, block, gasPrice, depth } = pick;
      console.log(`Forking ${net.name} at block ${block} via ${new URL(rpc).host}${depth < FORK_DEEP_HISTORY ? ' (keeps little history; may need a retry)' : ' (keeps deep history)'} (local only; nothing is sent to the chain)…`);
      let connection;
      try {
        connection = await network.create({ network: 'localTest', override: { chainId: 31337, hardfork: 'cancun', forking: { url: rpc, blockNumber: block } } });
        const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
        assert.equal(Number((await provider.getNetwork()).chainId), 31337, 'writes must stay on the local fork');
        await provider.send('evm_mine', []); // run on a local block, not upstream hardfork history
        const result = await runChainLifecycle({ provider, signer: await provider.getSigner(0), attacker: await provider.getSigner(1), dex, feed: oracle.feed, feedDescription: oracle.description ?? null, maxAge: oracle.maxAge, startFdvUsd: only?.startFdvUsd ?? 50, art, log: console.log });
        const deployGas = result.gas.filter(g => /^deploy|configure/.test(g.step)).reduce((s, g) => s + BigInt(g.gas), 0n);
        const allGas = result.gas.reduce((s, g) => s + BigInt(g.gas), 0n);
        Object.assign(report, result, { rpcHost: new URL(rpc).host, block, result: 'PASS', estimate: { gasPrice: gasPrice.toString(), gasPriceGwei: formatUnits(gasPrice, 'gwei'), deployGas: deployGas.toString(), fullRunGas: allGas.toString(), deployNative: formatEther(deployGas * gasPrice), fullRunNative: formatEther(allGas * gasPrice), suggestedFaucetNative: formatEther(allGas * gasPrice * 3n + parseEther('0.05')) } });
        const sym = net.nativeCurrency.symbol, e = report.estimate;
        console.log(only ? `\nResult: PASS. Mainnet gas price today ${e.gasPriceGwei} gwei: a real deployment would use ${deployGas} gas (about ${e.deployNative} ${sym}). Nothing was spent; this ran on a local fork.` : `\nResult: PASS. Gas price today ${e.gasPriceGwei} gwei. Deploying uses ${deployGas} gas (about ${e.deployNative} ${sym}); a full test run ${allGas} gas (about ${e.fullRunNative} ${sym}). Collect about ${e.suggestedFaucetNative} ${sym} (3x gas margin plus 0.05 for curve buys).`);
      } catch (error) {
        lastError = error;
        if (!isPrunedState(error)) break;
        console.log(`  ${new URL(rpc).host} dropped the state for block ${block} or refused service (${rootCause(error).slice(0, 120)}). Retrying on a fresh block${candidates.length > 1 ? ' or another RPC' : ''}…`);
      } finally { await connection?.close().catch(() => {}); }
    }
    if (!report.result) throw lastError ?? new Error('fork check did not run');
  } catch (error) {
    const cause = rootCause(error), headline = error.shortMessage ?? error.message;
    Object.assign(report, { result: 'FAIL', error: headline, cause, failedAt: error.step ?? null });
    console.log(`\nResult: FAIL${report.failedAt ? ' at ' + report.failedAt : ''}. ${report.error}${!headline.startsWith(cause) ? `\nCause: ${cause}` : ''}`);
    if (isPrunedState(error) || /answered with recent/.test(report.error)) console.log(`If those RPCs are up, they keep too little history for a fork. Use an RPC with archive state (free tiers: NodeReal MegaNode, dRPC, QuickNode, Chainstack) and run again with\n  $env:${`ELPIDA_FORK_RPC_${key.toUpperCase().replace(/-/g, '_')}`}="https://…"`);
    process.exitCode = 1;
  } finally {
    mkdirSync('backups/chain-fork', { recursive: true });
    writeFileSync(`backups/chain-fork/${key}.json`, JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    console.log(`Report: backups/chain-fork/${key}.json`);
  }
}

const FORK_ATTEMPTS = 4, FORK_DEEP_HISTORY = 5000;
// Chains checked only on a fork of their mainnet, because their testnet has no DEX or price feed. Read-only upstream;
// every write happens on the local fork. Robinhood Chain (23 Oct 2026): Chainlink lists no feeds on its testnet, and
// Uniswap's official v3 deployment is on mainnet only. Sources: Uniswap's Robinhood Chain v3 deployments page and
// Chainlink's price-feed address list (Robinhood Chain Mainnet, ETH / USD standard proxy). The run re-checks each
// address on-chain: the manager must belong to the factory, WETH must match, and the feed must describe ETH / USD.
export const FORK_ONLY = Object.freeze({
  'robinhood-mainnet': {
    net: { key: 'robinhood-mainnet', name: 'Robinhood Chain (mainnet fork)', chainId: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
    dex: { name: 'Uniswap v3', fee: 10000, factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', manager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3', router: '0xCaf681a66D020601342297493863E78C959E5cb2', quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', routerVersion: 2 },
    // Crypto feeds on Arbitrum-based chains update on deviation with a 24 h heartbeat, so allow a full day here.
    oracle: { feed: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', maxAge: 86400, description: 'ETH / USD' },
    startFdvUsd: 5000, // mainnet terms
  },
});

// Extra public RPCs tried after the network's own when the fork check needs state the first one has pruned.
export const FORK_RPC_FALLBACKS = Object.freeze({
  'bnb-testnet': ['https://bnb-testnet.api.onfinality.io/public', 'https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.drpc.org', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://data-seed-prebsc-2-s1.bnbchain.org:8545', 'https://data-seed-prebsc-1-s2.bnbchain.org:8545'],
  'ethereum-sepolia': ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
});
const FORK_PROBE = '0x90f79bf6eb2c4f870365e785982e1f101e93b906'; // a local test account the fork reads at startup

/**
 * Every message in an error chain. ethers reports ANY failure during gas estimation as "missing revert data" and keeps
 * the real cause (for a fork: the upstream RPC losing state or rate-limiting) in `info.error`, so look inside.
 */
export function errorMessages(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return typeof error === 'string' ? [error] : [];
  seen.add(error);
  const own = [error.shortMessage, error.message, error.reason, error.data?.message].filter(m => typeof m === 'string');
  return [...own, ...[error.info?.error, error.error, error.cause].flatMap(e => errorMessages(e, seen))];
}
/** The deepest message that explains a failure, for the report. */
export function rootCause(error) {
  const all = errorMessages(error).filter(m => m && !/^0x[0-9a-f]*$/i.test(m)), deep = all.filter(m => !/^missing revert data/i.test(m));
  return (deep.at(-1) ?? all[0] ?? String(error)).slice(0, 300);
}
/** The upstream RPC dropped the fork's state or refused service: retrying on a fresh block or another RPC helps. */
export function isPrunedState(error) {
  // A contract revert always carries data (at least "0x"); "missing revert data" means the node failed, not the contract.
  if (error?.code === 'CALL_EXCEPTION' && error.data == null && /^missing revert data/.test(error.shortMessage ?? '')) return true;
  return /missing trie node|state (is )?not available|historical state|state histories|pruned|header not found|unknown block|too many requests|rate limit|\b429\b|ECONNRESET|socket hang up|fetch failed|timed? ?out/i.test(errorMessages(error).join(' | '));
}

async function rpcCall(rpc, method, params = []) {
  const r = await (await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

/**
 * The first RPC (rotating by attempt) that is on the right chain and can still serve state a little behind its head.
 * Forks one block behind the head, so the state is as fresh as possible. `call` is injectable for tests.
 */
export async function chooseForkRpc(candidates, chainId, attempt = 0, { call = rpcCall, depths = [FORK_DEEP_HISTORY, 32], log = console.log } = {}) {
  const order = candidates.map((_, i) => candidates[(i + attempt) % candidates.length]);
  // Prefer an RPC that keeps deep history (an archive node); fall back to one that keeps a little.
  for (const [pass, depth] of depths.entries()) for (const rpc of order) {
    try {
      if (Number(BigInt(await call(rpc, 'eth_chainId'))) !== chainId) { log(`  skip ${rpc}: wrong chain`); continue; }
      const head = Number(BigInt(await call(rpc, 'eth_blockNumber')));
      const block = process.env.ELPIDA_FORK_BLOCK ? Number(process.env.ELPIDA_FORK_BLOCK) : head - 1;
      await call(rpc, 'eth_getCode', [FORK_PROBE, '0x' + Math.max(0, block - depth).toString(16)]); // proves some history is kept
      await call(rpc, 'eth_getCode', [FORK_PROBE, '0x' + block.toString(16)]);
      return { rpc, block, depth, gasPrice: BigInt(await call(rpc, 'eth_gasPrice')) };
    } catch (error) { if (pass === depths.length - 1) log(`  skip ${new URL(rpc).host}: ${(error.message ?? String(error)).slice(0, 120)}`); }
  }
  return null;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
