// Lifecycle check: our real factory, curve and Uniswap v3 graduation with a tokenized stock as the quote asset.
//   node scripts/equity-lifecycle-fork.mjs robinhood [SYMBOL]      (default AAPL)
// Runs on an in-process fork. The upstream RPC is only read; the stock tokens are funded by impersonating an
// existing holder on the fork. Our contracts are deployed on the fork only. Nothing is sent to the public chain.
// Optional env: ELPIDA_EQUITY_FORK_RPC_ROBINHOOD (or ELPIDA_EQUITY_FORK_RPC), ELPIDA_EQUITY_HOLDER, ELPIDA_EQUITY_EXPLORER.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { network } from 'hardhat';
import { BrowserProvider, JsonRpcSigner, Contract, ContractFactory, parseEther, toBeHex, ZeroAddress } from 'ethers';
import { compileContracts } from './compile.mjs';
import { deployLocalV3, v3Artifacts } from '../packages/core/uniswap.mjs';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
const ERC = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)'];

/**
 * Runs the whole lifecycle with `stockAddress` as the approved quote. `fund(signers)` must give signers 0 and 1 a
 * balance of the quote asset. Returns { checks, steps } and throws on the first failed assertion.
 */
export async function runLifecycle({ provider, stockAddress, fund, virtualQuote, firstBuy, tradeBuy, log = () => {} }) {
  const compiled = compileContracts({ includeMocks: true });
  const art = n => compiled['contracts/evm/src/' + n + '.sol'][n];
  const fixture = n => compiled['tests/fixtures/' + n + '.sol'][n];
  const checks = [], steps = [];
  const ok = (name, detail = '') => { checks.push({ name, ok: true, detail: String(detail) }); log(`PASS  ${name}${detail ? '  ' + detail : ''}`); };
  const mined = async p => { const r = await (await p).wait(); assert.equal(r.status, 1); return r; };
  const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const stock = new Contract(stockAddress, ERC, signers[0]);
  const decimals = Number(await stock.decimals());

  await fund(signers);
  assert.ok(await stock.balanceOf(addresses[0]) >= firstBuy + tradeBuy * 4n, 'signer 0 needs enough quote asset');
  assert.ok(await stock.balanceOf(addresses[1]) >= tradeBuy * 4n, 'signer 1 needs enough quote asset');
  ok('test accounts funded with the quote asset (raw units)');

  // Same deployment as the production launchpad fixture: local Uniswap v3, native adapter, factory, USD feed.
  const dex = await deployLocalV3(signers[0], fixture('LocalWrappedETH'));
  const nativeAdapter = await deploy(art('ElpidaV3MigrationAdapter'), dex.manager.target, dex.weth.target, 10000);
  const factory = await deploy(art('ElpidaDexFactory'), addresses[2], nativeAdapter.target, 5000, 86400);
  const feed = await deploy(fixture('MockUsdFeed'), 2500n * 10n ** 8n);
  await mined(factory.connect(signers[2]).configureUsdPricing(feed.target, 86400, ZeroAddress));
  const adapter = await deploy(art('ElpidaV3MigrationAdapter'), dex.manager.target, stockAddress, 10000);
  await mined(factory.connect(signers[2]).approveQuote(stockAddress, virtualQuote, adapter.target));
  ok('factory approves the stock as a quote asset', `decimals ${decimals}, virtual quote ${virtualQuote}`);

  // Launch paired with the stock: the factory pulls the first buy with transferFrom and checks the balance delta.
  const FEE = parseEther('0.004');
  await mined(stock.connect(signers[0]).approve(factory.target, firstBuy));
  const launchReceipt = await mined(factory.connect(signers[0]).launchPaired('Hope', 'HOPE', stockAddress, firstBuy, 0, addresses[0], { value: FEE }));
  const ev = launchReceipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
  assert.ok(ev, 'Launched event');
  const curve = new Contract(ev.args.curve, art('ElpidaDexCurve').abi, signers[0]);
  const token = new Contract(ev.args.token, art('ElpidaToken').abi, signers[0]);
  assert.equal((await curve.quote()).toLowerCase(), stockAddress.toLowerCase());
  const liabilities = async () => await curve.realReserve() + await curve.protocolFees() + await curve.creatorFees() + await curve.liquidityBonus();
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('paired launch with the stock as first buy; curve holds exactly its liabilities', `balance ${await stock.balanceOf(curve.target)}`);
  assert.equal(await stock.allowance(factory.target, curve.target), 0n);
  ok('factory leaves no approval behind');

  // Trading after the anti-snipe window, both directions, with the invariant checked after each step.
  await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
  const trader = signers[1];
  await mined(stock.connect(trader).approve(curve.target, tradeBuy));
  const [quotedOut] = await curve.quoteBuy(tradeBuy);
  const before = await token.balanceOf(addresses[1]);
  await mined(curve.connect(trader).buy(tradeBuy, quotedOut * 99n / 100n));
  const got = (await token.balanceOf(addresses[1])) - before;
  assert.ok(got >= quotedOut * 99n / 100n);
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('buy with the stock; balance delta equals the amount spent', `tokens out ${got}`);
  const sellAmount = got / 2n;
  await mined(token.connect(trader).approve(curve.target, sellAmount));
  const stockBefore = await stock.balanceOf(addresses[1]);
  const [sellOut] = await curve.quoteSell(sellAmount);
  await mined(curve.connect(trader).sell(sellAmount, sellOut * 99n / 100n));
  assert.equal((await stock.balanceOf(addresses[1])) - stockBefore, sellOut);
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('sell back into the stock; payout is exact and the curve stays fully backed', `paid ${sellOut}`);

  // Fee payouts to the fixed recipients.
  const owedProtocol = await curve.protocolFees(), owedCreator = await curve.creatorFees();
  const tBefore = await stock.balanceOf(await curve.protocolTreasury()), cBefore = await stock.balanceOf(await curve.creatorRewardVault());
  await mined(curve.withdrawFees());
  assert.equal(await curve.protocolFees(), 0n); assert.equal(await curve.creatorFees(), 0n);
  const sameWallet = (await curve.protocolTreasury()).toLowerCase() === (await curve.creatorRewardVault()).toLowerCase();
  if (sameWallet) assert.equal((await stock.balanceOf(await curve.protocolTreasury())) - tBefore, owedProtocol + owedCreator);
  else { assert.equal((await stock.balanceOf(await curve.protocolTreasury())) - tBefore, owedProtocol); assert.equal((await stock.balanceOf(await curve.creatorRewardVault())) - cBefore, owedCreator); }
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('protocol and creator fees paid in the stock, raw amounts exact', `protocol ${owedProtocol}, creator ${owedCreator}`);

  // Complete the curve and graduate into Uniswap v3 with the stock as the other side of the pair.
  const gross = await curve.completionQuote();
  await mined(stock.connect(trader).approve(curve.target, gross));
  assert.ok(await stock.balanceOf(addresses[1]) >= gross, 'signer 1 needs enough quote asset to complete the curve (raise the funding)');
  await mined(curve.connect(trader).buy(gross, 0));
  assert.equal(await curve.complete(), true);
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('curve completes on a stock-denominated purchase');
  const terminalQ = await curve.virtualQuote() + await curve.realReserve(), terminalT = await curve.virtualToken() - await curve.sold();
  await mined(curve.graduate({ gasLimit: 15000000 }));
  const poolAddress = await curve.pool(); assert.notEqual(poolAddress, ZeroAddress);
  const manager = new Contract(dex.manager.target, v3Artifacts.manager.abi, signers[0]);
  const pool = new Contract(poolAddress, v3Artifacts.pool.abi, provider);
  const lockerAddress = await curve.locker(), positionId = await curve.positionId();
  assert.equal((await manager.ownerOf(positionId)).toLowerCase(), lockerAddress.toLowerCase());
  const liquidity = (await manager.positions(positionId)).liquidity; assert.ok(liquidity > 0n);
  const tokenFirst = (await pool.token0()).toLowerCase() === token.target.toLowerCase();
  const sqrt = (await pool.slot0())[0], n = tokenFirst ? sqrt * sqrt : 2n ** 192n, d = tokenFirst ? 2n ** 192n : sqrt * sqrt;
  const actual = n * 10n ** 30n / d, expectedPrice = terminalQ * 10n ** 30n / terminalT;
  assert.ok((actual > expectedPrice ? actual - expectedPrice : expectedPrice - actual) * 1000000n <= expectedPrice, 'terminal price continuity');
  ok('graduation into Uniswap v3 with the stock as the quote side; price continuous; position locked', `pool ${poolAddress}`);

  // Post-graduation trading through the router in both directions.
  const router = new Contract(dex.router.target, v3Artifacts.router.abi, signers[0]);
  const args = { tokenIn: stockAddress, tokenOut: token.target, fee: 10000, recipient: addresses[0], amountIn: tradeBuy, amountOutMinimum: 0, sqrtPriceLimitX96: 0 };
  await mined(stock.connect(signers[0]).approve(router.target, tradeBuy));
  const out = await router.exactInputSingle.staticCall(args); assert.ok(out > 0n);
  await mined(router.exactInputSingle({ ...args, amountOutMinimum: out * 99n / 100n }));
  const sellIn = out / 2n;
  await mined(token.connect(signers[0]).approve(router.target, sellIn));
  const sArgs = { ...args, tokenIn: token.target, tokenOut: stockAddress, amountIn: sellIn };
  const sOut = await router.exactInputSingle.staticCall(sArgs); assert.ok(sOut > 0n);
  const sb = await stock.balanceOf(addresses[0]);
  await mined(router.exactInputSingle({ ...sArgs, amountOutMinimum: sOut * 99n / 100n }));
  assert.ok(await stock.balanceOf(addresses[0]) > sb);
  ok('post-graduation buy and sell through Uniswap v3 with the stock');

  // Locked liquidity collects fees; principal is untouched.
  const locker = new Contract(lockerAddress, art('ElpidaV3FeeLocker').abi, signers[0]);
  await mined(locker.collectFees());
  assert.equal((await manager.positions(positionId)).liquidity, liquidity);
  assert.equal((await manager.ownerOf(positionId)).toLowerCase(), lockerAddress.toLowerCase());
  ok('locked position collects fees in the stock; principal unchanged');
  return { checks, steps };
}

async function findHolder({ explorer, address, balanceOf, log }) {
  if (process.env.ELPIDA_EQUITY_HOLDER) return process.env.ELPIDA_EQUITY_HOLDER;
  const r = await fetch(`${explorer}/api/v2/tokens/${address}/holders`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; elpida-fork-check)' } });
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}; set ELPIDA_EQUITY_HOLDER=<address>`);
  for (const it of ((await r.json()).items ?? []).slice(0, 10)) { const a = it.address?.hash; if (a && await balanceOf(a) > 0n) { log(`  holder from explorer: ${a}${it.address?.name ? ' (' + it.address.name + ')' : ''}`); return a; } }
  throw new Error('no holder with a balance; set ELPIDA_EQUITY_HOLDER=<address>');
}

async function main() {
  const net = process.argv[2], symbol = process.argv[3] ?? 'AAPL';
  assert.equal(net, 'robinhood', 'Usage: node scripts/equity-lifecycle-fork.mjs robinhood [SYMBOL]  (Base tokens are precompiles and cannot run in a local fork)');
  const def = config.networks[net];
  const asset = config.assets.find(a => a.network === net && a.symbol === symbol);
  assert.ok(asset, `No registry asset ${symbol} on ${net}.`);
  const rpc = process.env[`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`] ?? process.env.ELPIDA_EQUITY_FORK_RPC ?? def.rpc;
  const remote = async (method, params = []) => { const r = await (await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json(); if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; };
  assert.equal(Number(BigInt(await remote('eth_chainId'))), def.chainId, `upstream must be chain ${def.chainId}`);
  const head = Number(BigInt(await remote('eth_blockNumber')));
  const balOf = async addr => BigInt(await remote('eth_call', [{ to: asset.address, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, '0x' + (head - 5).toString(16)]));
  const holder = await findHolder({ explorer: (process.env.ELPIDA_EQUITY_EXPLORER ?? def.explorer).replace(/\/$/, ''), address: asset.address, balanceOf: balOf, log: console.log });
  const holderBal = await balOf(holder);
  const connection = await network.create({ network: 'localTest', override: { chainId: 31337, hardfork: 'cancun', forking: { url: rpc, blockNumber: head - 5 } } });
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const report = { scope: 'LOCAL FORK ONLY: nothing is sent to the public chain', network: net, chainId: def.chainId, block: head - 5, symbol, token: asset.address, holder, results: [] };
  try {
    await provider.send('hardhat_metadata', []);
    await provider.send('evm_mine', []);
    const unit = 10n ** BigInt(asset.decimals ?? 18);
    // Size everything from what the holder has: the virtual quote is 20 whole tokens (test sizing, not a price).
    const virtualQuote = 20n * unit, firstBuy = unit, tradeBuy = unit;
    const need = virtualQuote * 4n;
    assert.ok(holderBal >= need * 2n, `holder ${holder} has too little ${symbol} for the test (needs ${need * 2n}, has ${holderBal}); set ELPIDA_EQUITY_HOLDER`);
    const fund = async signers => {
      await provider.send('hardhat_impersonateAccount', [holder]); await provider.send('hardhat_setBalance', [holder, toBeHex(parseEther('10'))]);
      const h = new Contract(asset.address, ERC, new JsonRpcSigner(provider, holder));
      for (const s of signers.slice(0, 2)) await (await h.transfer(await s.getAddress(), need)).wait();
      await provider.send('hardhat_stopImpersonatingAccount', [holder]);
    };
    const res = await runLifecycle({ provider, stockAddress: asset.address, fund, virtualQuote, firstBuy, tradeBuy, log: console.log });
    report.results = res.checks; report.result = 'PASS';
  } catch (e) {
    report.result = 'FAIL'; report.error = e.shortMessage ?? e.message; console.log(`FAIL  ${report.error}`);
  } finally {
    mkdirSync('backups/equity-fork', { recursive: true });
    writeFileSync(`backups/equity-fork/${net}-lifecycle-report.json`, JSON.stringify(report, null, 2));
    provider.destroy(); await connection.close();
    console.log(`\nResult: ${report.result}. Report: backups/equity-fork/${net}-lifecycle-report.json`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
