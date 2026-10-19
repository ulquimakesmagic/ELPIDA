// Issuer-power check: what happens to our launchpad contracts if the stock issuer uses its powers.
//   node scripts/equity-issuer-powers-fork.mjs robinhood [SYMBOL]      (default AAPL)
// On an in-process fork of Robinhood Chain, deploys our real factory, curve and Uniswap v3 adapter with a real stock
// token as the quote asset, then simulates the issuer: blocking our curve or pool, pausing the token, burning from
// our curve, and changing the multiplier. The issuer accounts are impersonated on the fork ONLY. Nothing is signed or
// sent to the public chain, and no key or funds are used.
// Optional env: ELPIDA_EQUITY_FORK_RPC_ROBINHOOD (or ELPIDA_EQUITY_FORK_RPC), ELPIDA_EQUITY_HOLDER, ELPIDA_EQUITY_EXPLORER,
// ELPIDA_EQUITY_ADMIN (comma-separated extra issuer-role candidates).
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { network } from 'hardhat';
import { BrowserProvider, JsonRpcSigner, Contract, ContractFactory, Interface, parseEther, toBeHex, id, ZeroAddress } from 'ethers';
import { compileContracts } from './compile.mjs';
import { deployLocalV3, v3Artifacts } from '../packages/core/uniswap.mjs';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
const ERC = ['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)', 'function uiMultiplier() view returns(uint256)'];
const NAMES = {
  block: ['blockAccounts', 'blockAccount', 'blacklist', 'block'],
  unblock: ['unblockAccounts', 'unblockAccount', 'unblacklist', 'unblock'],
  pause: ['pause'], unpause: ['unpause'],
  burn: ['adminBurn'],
  multiplier: ['updateMultiplier', 'setMultiplier'],
};

const ACCESS_ERROR = /access|role|unauthori[sz]ed|not (an? )?(owner|admin|issuer|authori[sz]ed)|only|caller|forbidden|permission|issuer/i;

/** Argument list for an ABI function: addresses get `target`, uints get `amount` (or `value` for multiplier-like names). */
function buildArgs(fragment, { target, amount, value }) {
  return fragment.inputs.map(i => {
    if (i.type === 'address') return target;
    if (i.type === 'address[]') return [target];
    if (i.type === 'bool') return true;
    if (/^uint/.test(i.type)) return /time|date|activ|effective/i.test(i.name ?? '') ? 0n : /mult|factor|value|ratio/i.test(i.name ?? '') ? value : amount;
    throw new Error(`unsupported parameter type ${i.type} in ${fragment.name}`);
  });
}

/**
 * Finds the issuer operations on the given verified contracts (searched in order) and an account that is allowed to call
 * each one, by simulating the call from every candidate. Missing operations come back as `{ missing: reason }`.
 */
export async function buildIssuerOps({ provider, sources, candidates }) {
  const ops = {};
  for (const [op, names] of Object.entries(NAMES)) {
    let found = null;
    for (const src of sources) {
      const iface = new Interface(src.abi);
      for (const name of names) {
        const fragment = iface.fragments.find(f => f.type === 'function' && f.name === name);
        if (fragment) { found = { src, iface, fragment }; break; }
      }
      if (found) break;
    }
    if (!found) { ops[op] = { missing: `no function named ${names.join('/')} on the verified contracts` }; continue; }
    const probe = buildArgs(found.fragment, { target: '0x00000000000000000000000000000000000dead1', amount: 1n, value: 1n });
    let caller = null, lastError = '';
    for (const c of candidates) {
      try { await provider.call({ to: found.src.address, from: c, data: found.iface.encodeFunctionData(found.fragment, probe) }); caller = c; break; }
      catch (e) {
        lastError = e.shortMessage ?? e.message;
        // A state precondition (for example no balance to burn) is not a permission failure: the account passed the access check.
        const reason = e.reason ?? /reverted: "([^"]*)"/.exec(lastError)?.[1];
        if (reason && !ACCESS_ERROR.test(reason)) { caller = c; break; }
      }
    }
    if (!caller) { ops[op] = { missing: `no candidate account may call ${found.fragment.name} (${candidates.length} tried; last error: ${lastError})` }; continue; }
    ops[op] = {
      name: found.fragment.name, to: found.src.address, caller,
      async run({ target = ZeroAddress, amount = 0n, value = 0n } = {}) {
        await provider.send('hardhat_impersonateAccount', [caller]); await provider.send('hardhat_setBalance', [caller, toBeHex(parseEther('10'))]);
        try {
          const data = found.iface.encodeFunctionData(found.fragment, buildArgs(found.fragment, { target, amount, value }));
          const r = await (await new JsonRpcSigner(provider, caller).sendTransaction({ to: found.src.address, data })).wait();
          assert.equal(r.status, 1);
        } finally { await provider.send('hardhat_stopImpersonatingAccount', [caller]); }
      },
    };
  }
  return ops;
}

/** Runs every scenario that the available issuer operations allow. Exported for the offline test. */
export async function runIssuerPowers({ provider, stockAddress, fund, ops, virtualQuote, firstBuy, tradeBuy, log = () => {} }) {
  const compiled = compileContracts({ includeMocks: true });
  const art = n => compiled['contracts/evm/src/' + n + '.sol'][n];
  const fixture = n => compiled['tests/fixtures/' + n + '.sol'][n];
  const checks = [], observations = [];
  const ok = (name, detail = '') => { checks.push({ name, ok: true, detail: String(detail) }); log(`PASS  ${name}${detail ? '  ' + detail : ''}`); };
  const obs = (name, detail) => { observations.push({ name, detail: String(detail) }); log(`NOTE  ${name}  ${detail}`); };
  const skip = (name, why) => { observations.push({ name, detail: 'SKIPPED: ' + why }); log(`SKIP  ${name}: ${why}`); };
  const mined = async p => { const r = await (await p).wait(); assert.equal(r.status, 1); return r; };
  const attempt = async fn => { try { await fn(); return { ok: true }; } catch (e) { return { ok: false, error: (e.shortMessage ?? e.message ?? String(e)).slice(0, 140) }; } };
  const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const stock = new Contract(stockAddress, ERC, signers[0]);
  await fund(signers);

  const dex = await deployLocalV3(signers[0], fixture('LocalWrappedETH'));
  const nativeAdapter = await deploy(art('ElpidaV3MigrationAdapter'), dex.manager.target, dex.weth.target, 10000);
  const factory = await deploy(art('ElpidaDexFactory'), addresses[2], nativeAdapter.target, 5000, 86400);
  const feed = await deploy(fixture('MockUsdFeed'), 2500n * 10n ** 8n);
  await mined(factory.connect(signers[2]).configureUsdPricing(feed.target, 86400, ZeroAddress));
  const adapter = await deploy(art('ElpidaV3MigrationAdapter'), dex.manager.target, stockAddress, 10000);
  await mined(factory.connect(signers[2]).approveQuote(stockAddress, virtualQuote, adapter.target));
  await mined(stock.approve(factory.target, firstBuy));
  const rc = await mined(factory.launchPaired('Hope', 'HOPE', stockAddress, firstBuy, 0, addresses[0], { value: parseEther('0.004') }));
  const ev = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Launched');
  const curve = new Contract(ev.args.curve, art('ElpidaDexCurve').abi, signers[0]);
  const token = new Contract(ev.args.token, art('ElpidaToken').abi, signers[0]);
  const liabilities = async () => await curve.realReserve() + await curve.protocolFees() + await curve.creatorFees() + await curve.liquidityBonus();
  await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
  const trader = signers[1];
  await mined(stock.connect(trader).approve(curve.target, tradeBuy * 3n));
  await mined(curve.connect(trader).buy(tradeBuy, 0));
  const held = await token.balanceOf(addresses[1]); assert.ok(held > 0n);
  assert.equal(await stock.balanceOf(curve.target), await liabilities());
  ok('baseline: curve launched with the stock as quote, one buy done, curve fully backed');
  const sellSmall = () => mined(token.connect(trader).approve(curve.target, held / 8n)).then(() => mined(curve.connect(trader).sell(held / 8n, 0)));
  const buySmall = () => mined(curve.connect(trader).buy(tradeBuy / 4n, 0));
  const snapshot = () => provider.send('evm_snapshot', []);
  const restore = async s => { await provider.send('evm_revert', [s]); };

  // A. The issuer blocks our curve.
  if (ops.block?.run && ops.unblock?.run) {
    const s = await snapshot();
    await ops.block.run({ target: curve.target });
    const sell = await attempt(sellSmall), buy = await attempt(buySmall);
    obs('A. issuer blocks the curve: trades while blocked', `sell ${sell.ok ? 'succeeded' : 'reverted'}, buy ${buy.ok ? 'succeeded' : 'reverted'}${sell.ok ? '' : ' (' + sell.error + ')'}`);
    await ops.unblock.run({ target: curve.target });
    await sellSmall(); await buySmall();
    assert.equal(await stock.balanceOf(curve.target), await liabilities());
    ok('A. after the issuer unblocks the curve, trading resumes and the curve is fully backed', `while blocked: sell ${sell.ok ? 'worked' : 'reverted'}, buy ${buy.ok ? 'worked' : 'reverted'}`);
    await restore(s);
  } else skip('A. issuer blocks the curve', ops.block?.missing ?? ops.unblock?.missing ?? 'block/unblock not available');

  // B. The issuer pauses the token.
  if (ops.pause?.run && ops.unpause?.run) {
    const s = await snapshot();
    await ops.pause.run();
    const sell = await attempt(sellSmall), buy = await attempt(buySmall);
    obs('B. issuer pauses the token: trades while paused', `sell ${sell.ok ? 'succeeded' : 'reverted'}, buy ${buy.ok ? 'succeeded' : 'reverted'}`);
    await ops.unpause.run();
    await sellSmall(); await buySmall();
    assert.equal(await stock.balanceOf(curve.target), await liabilities());
    ok('B. after the issuer unpauses, trading resumes and the curve is fully backed');
    await restore(s);
  } else skip('B. issuer pauses the token', ops.pause?.missing ?? ops.unpause?.missing ?? 'pause/unpause not available');

  // C. The issuer burns part of the curve's reserve.
  if (ops.burn?.run) {
    const s = await snapshot();
    const before = await stock.balanceOf(curve.target), burned = before / 2n;
    await ops.burn.run({ target: curve.target, amount: burned });
    const shortfall = await liabilities() - await stock.balanceOf(curve.target);
    assert.equal(shortfall, burned);
    const sellAll = await attempt(async () => { await mined(token.connect(trader).approve(curve.target, held)); await mined(curve.connect(trader).sell(held, 0)); });
    const sellOne = await attempt(sellSmall);
    const fees = await attempt(() => mined(curve.withdrawFees()));
    obs('C. issuer burns half of the curve reserve: shortfall against liabilities', `${shortfall} raw units (${(Number(shortfall) * 100 / Number(before)).toFixed(0)}% of the reserve)`);
    obs('C. after the burn: selling everything / a small sell / withdrawFees', `${sellAll.ok ? 'succeeded' : 'reverted'} / ${sellOne.ok ? 'succeeded' : 'reverted'} / ${fees.ok ? 'succeeded' : 'reverted'}`);
    ok('C. an issuer burn from the curve makes it insolvent by exactly the burned amount (risk confirmed, must be disclosed)');
    await restore(s);
  } else skip('C. issuer burns from the curve', ops.burn?.missing ?? 'adminBurn not available');

  // D. The issuer changes the multiplier while a position is open.
  if (ops.multiplier?.run) {
    const s = await snapshot();
    let ui0 = null; try { ui0 = await new Contract(stockAddress, ERC, provider).uiMultiplier(); } catch { /* no getter */ }
    const next = ui0 ? ui0 * 105n / 100n : 105n * 10n ** 16n;
    const rawBefore = await stock.balanceOf(curve.target);
    const r = await attempt(() => ops.multiplier.run({ value: next }));
    if (!r.ok) skip('D. issuer changes the multiplier', r.error);
    else {
      assert.equal(await stock.balanceOf(curve.target), rawBefore);
      assert.equal(await stock.balanceOf(curve.target), await liabilities());
      await sellSmall(); await buySmall();
      assert.equal(await stock.balanceOf(curve.target), await liabilities());
      let ui1 = null; try { ui1 = await new Contract(stockAddress, ERC, provider).uiMultiplier(); } catch { /* no getter */ }
      ok('D. a multiplier change leaves raw balances and the curve accounting untouched; trading continues', ui0 !== null ? `multiplier ${ui0} -> ${ui1}` : 'multiplier getter unavailable');
    }
    await restore(s);
  } else skip('D. issuer changes the multiplier', ops.multiplier?.missing ?? 'updateMultiplier not available');

  // E. After graduation the issuer blocks the Uniswap pool.
  if (ops.block?.run && ops.unblock?.run) {
    const s = await snapshot();
    const gross = await curve.completionQuote();
    assert.ok(await stock.balanceOf(addresses[1]) >= gross, 'fund signer 1 with more of the quote asset to complete the curve');
    await mined(stock.connect(trader).approve(curve.target, gross)); await mined(curve.connect(trader).buy(gross, 0));
    await mined(curve.graduate({ gasLimit: 15000000 }));
    const pool = await curve.pool(); assert.notEqual(pool, ZeroAddress);
    const router = new Contract(dex.router.target, v3Artifacts.router.abi, signers[0]);
    const swap = async () => { await mined(stock.connect(signers[0]).approve(router.target, tradeBuy)); const a = { tokenIn: stockAddress, tokenOut: token.target, fee: 10000, recipient: addresses[0], amountIn: tradeBuy, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }; return mined(router.exactInputSingle(a)); };
    await swap(); ok('E. baseline: post-graduation swap works with the stock');
    await ops.block.run({ target: pool });
    const blockedSwap = await attempt(swap);
    obs('E. issuer blocks the Uniswap pool: swap while blocked', blockedSwap.ok ? 'succeeded' : 'reverted (' + blockedSwap.error + ')');
    await ops.unblock.run({ target: pool });
    await swap(); ok('E. after the issuer unblocks the pool, swaps resume', `while blocked the swap ${blockedSwap.ok ? 'worked' : 'reverted'}`);
    await restore(s);
  } else skip('E. issuer blocks the pool', 'block/unblock not available');
  return { checks, observations };
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; elpida-fork-check)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function findHolder({ explorer, address, balanceOf, log }) {
  if (process.env.ELPIDA_EQUITY_HOLDER) return process.env.ELPIDA_EQUITY_HOLDER;
  for (const it of ((await getJson(`${explorer}/api/v2/tokens/${address}/holders`)).items ?? []).slice(0, 10)) { const a = it.address?.hash; if (a && await balanceOf(a) > 0n) { log(`  holder from explorer: ${a}${it.address?.name ? ' (' + it.address.name + ')' : ''}`); return a; } }
  throw new Error('no holder with a balance; set ELPIDA_EQUITY_HOLDER=<address>');
}

/** Accounts that were ever granted a role on a contract (RoleGranted logs), through the explorer. */
async function roleGrantees(explorer, address, log) {
  const topic0 = id('RoleGranted(bytes32,address,address)'), out = new Set();
  try {
    let q = '';
    for (let page = 0; page < 8; page++) {
      const j = await getJson(`${explorer}/api/v2/addresses/${address}/logs${q}`);
      for (const it of j.items ?? []) if (it.topics?.[0]?.toLowerCase() === topic0.toLowerCase() && it.topics[2]) out.add('0x' + it.topics[2].slice(26));
      if (!j.next_page_params) break;
      q = '?' + new URLSearchParams(Object.fromEntries(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)]))).toString();
    }
  } catch (e) { log(`  role lookup on ${address} failed: ${e.message}`); }
  return [...out];
}

async function main() {
  const net = process.argv[2], symbol = process.argv[3] ?? 'AAPL';
  assert.equal(net, 'robinhood', 'Usage: node scripts/equity-issuer-powers-fork.mjs robinhood [SYMBOL]');
  const def = config.networks[net];
  const asset = config.assets.find(a => a.network === net && a.symbol === symbol);
  assert.ok(asset, `No registry asset ${symbol} on ${net}.`);
  const rpc = process.env[`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`] ?? process.env.ELPIDA_EQUITY_FORK_RPC ?? def.rpc;
  const remote = async (method, params = []) => { const r = await (await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json(); if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; };
  assert.equal(Number(BigInt(await remote('eth_chainId'))), def.chainId, `upstream must be chain ${def.chainId}`);
  const head = Number(BigInt(await remote('eth_blockNumber')));
  const explorer = (process.env.ELPIDA_EQUITY_EXPLORER ?? def.explorer).replace(/\/$/, '');
  const balOf = async addr => BigInt(await remote('eth_call', [{ to: asset.address, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, '0x' + (head - 5).toString(16)]));
  const holder = await findHolder({ explorer, address: asset.address, balanceOf: balOf, log: console.log });
  const holderBal = await balOf(holder);
  const findings = config.providers.robinhood.onchainFindings;
  const registryAddress = findings.registryAndBeacon.match(/0x[0-9a-fA-F]{40}/)[0];
  const implAddress = findings.proxy.match(/0x[0-9a-fA-F]{40}/)[0];
  const abiOf = async address => (await getJson(`${explorer}/api/v2/smart-contracts/${address}`)).abi;
  const sources = [{ address: asset.address, abi: await abiOf(implAddress) }, { address: registryAddress, abi: await abiOf(registryAddress) }];
  const candidates = [...new Set([...(process.env.ELPIDA_EQUITY_ADMIN ?? '').split(',').filter(Boolean), ...await roleGrantees(explorer, registryAddress, console.log), ...await roleGrantees(explorer, asset.address, console.log)])];
  console.log(`  ${candidates.length} issuer-role candidate account(s) found`);
  const connection = await network.create({ network: 'localTest', override: { chainId: 31337, hardfork: 'cancun', forking: { url: rpc, blockNumber: head - 5 } } });
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const report = { scope: 'LOCAL FORK ONLY: nothing is sent to the public chain', network: net, chainId: def.chainId, block: head - 5, symbol, token: asset.address, holder, candidates: candidates.length };
  try {
    await provider.send('hardhat_metadata', []); await provider.send('evm_mine', []);
    const ops = await buildIssuerOps({ provider, sources, candidates });
    report.issuerOps = Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v.missing ? { missing: v.missing } : { function: v.name, on: v.to, callerFound: true }]));
    for (const [k, v] of Object.entries(ops)) console.log(`  issuer op ${k}: ${v.missing ?? `${v.name} on ${v.to}`}`);
    const unit = 10n ** BigInt(asset.decimals ?? 18), virtualQuote = 20n * unit, need = virtualQuote * 4n;
    assert.ok(holderBal >= need * 2n, `holder ${holder} has too little ${symbol}; set ELPIDA_EQUITY_HOLDER`);
    const fund = async signers => {
      await provider.send('hardhat_impersonateAccount', [holder]); await provider.send('hardhat_setBalance', [holder, toBeHex(parseEther('10'))]);
      const h = new Contract(asset.address, ERC, new JsonRpcSigner(provider, holder));
      for (const s of signers.slice(0, 2)) await (await h.transfer(await s.getAddress(), need)).wait();
      await provider.send('hardhat_stopImpersonatingAccount', [holder]);
    };
    const res = await runIssuerPowers({ provider, stockAddress: asset.address, fund, ops, virtualQuote, firstBuy: unit, tradeBuy: unit, log: console.log });
    Object.assign(report, res); report.result = 'PASS';
  } catch (e) { report.result = 'FAIL'; report.error = e.shortMessage ?? e.message; console.log(`FAIL  ${report.error}`); }
  finally {
    mkdirSync('backups/equity-fork', { recursive: true });
    writeFileSync(`backups/equity-fork/${net}-issuer-powers-report.json`, JSON.stringify(report, null, 2));
    provider.destroy(); await connection.close();
    console.log(`\nResult: ${report.result}. Report: backups/equity-fork/${net}-issuer-powers-report.json`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
