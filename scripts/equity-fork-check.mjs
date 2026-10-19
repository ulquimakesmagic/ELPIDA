// Local-fork compatibility check for tokenized stocks. Run on a machine that can reach the chain's RPC.
//   node scripts/equity-fork-check.mjs robinhood [SYMBOL ...]
//   node scripts/equity-fork-check.mjs base [SYMBOL ...]
// All writes happen on an in-process simulated chain. The upstream RPC is only read. No private key, wallet
// or funded account is used: the script impersonates an existing holder on the fork only.
// Optional: ELPIDA_EQUITY_FORK_RPC (override the RPC), ELPIDA_EQUITY_HOLDER (override holder discovery).
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { network } from 'hardhat';
import { BrowserProvider, JsonRpcSigner, Contract, ContractFactory, parseUnits, toBeHex, id } from 'ethers';
import { compileContracts } from './compile.mjs';

const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
const ERC = ['function name() view returns(string)', 'function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)'];
const SCALED = ['function uiMultiplier() view returns(uint256)', 'function balanceOfUI(address) view returns(uint256)', 'function paused() view returns(bool)', 'function oraclePaused() view returns(bool)'];
const REGISTRY = ['function isBlocked(address) view returns(bool)', 'function paused() view returns(bool)'];
const WAD = 10n ** 18n;

/** Runs the checks for one token on a provider that has the hardhat_* testing API. Exported for offline tests. */
export async function runTokenChecks({ provider, tokenAddress, holder, probeArtifact, expect = {}, registryAddress = null, upstream = null }) {
  const checks = [];
  const record = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
  await provider.send('hardhat_impersonateAccount', [holder]);
  await provider.send('hardhat_setBalance', [holder, toBeHex(parseUnits('5', 18))]);
  const signer = new JsonRpcSigner(provider, holder);
  const token = new Contract(tokenAddress, [...ERC, ...SCALED], signer);
  const [eoa1, eoa2] = [await (await provider.getSigner(1)).getAddress(), await (await provider.getSigner(2)).getAddress()];
  const dec = Number(await token.decimals());
  if (expect.symbol) record('symbol matches registry', (await token.symbol()) === expect.symbol, `${await token.symbol()}`);
  if (expect.decimals != null) record('decimals match registry', dec === expect.decimals, `${dec}`);
  const held = await token.balanceOf(holder);
  record('holder has a balance to test with', held > 10n ** BigInt(Math.max(dec - 4, 1)), held.toString());
  // Balance semantics.
  let multiplier = WAD;
  try {
    multiplier = await token.uiMultiplier();
    const ui = await token.balanceOfUI(holder);
    record('balanceOf is raw and balanceOfUI = raw x multiplier', ui === (held * multiplier) / WAD || (ui > held ? ui - (held * multiplier) / WAD <= 1n : (held * multiplier) / WAD - ui <= 1n), `multiplier ${Number(multiplier) / 1e18}`);
    record('token not paused', (await token.paused().catch(() => false)) === false);
    record('oracle not paused', (await token.oraclePaused().catch(() => false)) === false);
  } catch { record('multiplier interface present', false, 'uiMultiplier/balanceOfUI missing'); }
  if (registryAddress) {
    const reg = new Contract(registryAddress, REGISTRY, provider);
    record('issuer registry not paused', (await reg.paused()) === false);
  }
  const probeFactory = new ContractFactory(probeArtifact.abi, probeArtifact.evm.bytecode.object, await provider.getSigner(0));
  const probe = await probeFactory.deploy(); await probe.waitForDeployment();
  const probeAddress = await probe.getAddress();
  if (registryAddress) record('probe contract is not blocked', (await new Contract(registryAddress, REGISTRY, provider).isBlocked(probeAddress)) === false);
  const unit = 10n ** BigInt(Math.max(dec - 4, 0)) * 7n; // a small odd amount in base units
  const tryStep = async (name, fn) => { try { await fn(); record(name, true); } catch (e) { record(name, false, e.shortMessage ?? e.message); } };
  await tryStep('holder -> EOA transfer conserves the raw amount', async () => { const b = await token.balanceOf(eoa1); await (await token.transfer(eoa1, unit)).wait(); assert.equal((await token.balanceOf(eoa1)) - b, unit); });
  await tryStep('EOA -> EOA transfer', async () => { const t = token.connect(await provider.getSigner(1)); await provider.send('hardhat_setBalance', [eoa1, toBeHex(parseUnits('1', 18))]); const b = await token.balanceOf(eoa2); await (await t.transfer(eoa2, unit)).wait(); assert.equal((await token.balanceOf(eoa2)) - b, unit); });
  await tryStep('holder -> contract (curve/pool/vault stand-in) conserves the raw amount', async () => { await (await token.transfer(probeAddress, unit * 3n)).wait(); assert.equal(await probe.balance(tokenAddress), unit * 3n); });
  await tryStep('contract -> EOA sweep', async () => { await (await probe.sweep(tokenAddress, eoa2, unit)).wait(); assert.equal(await probe.balance(tokenAddress), unit * 2n); });
  await tryStep('approve + transferFrom pull by a contract (pool/router pattern)', async () => { await (await token.approve(probeAddress, unit)).wait(); const b = await probe.balance(tokenAddress); await (await probe.pull(tokenAddress, holder, unit)).wait(); assert.equal((await probe.balance(tokenAddress)) - b, unit); });
  await tryStep('one base unit moves exactly', async () => { const b = await token.balanceOf(eoa2); await (await token.transfer(eoa2, 1n)).wait(); assert.equal((await token.balanceOf(eoa2)) - b, 1n); });
  await provider.send('hardhat_stopImpersonatingAccount', [holder]);
  return { token: tokenAddress, holder, decimals: dec, multiplier: multiplier.toString(), checks, pass: checks.every(c => c.ok) };
}

async function main() {
  const net = process.argv[2];
  const def = config.networks[net];
  assert.ok(def && ['robinhood', 'base'].includes(net), 'Usage: node scripts/equity-fork-check.mjs robinhood|base [SYMBOL ...]');
  const rpc = process.env.ELPIDA_EQUITY_FORK_RPC ?? def.rpc ?? { base: 'https://mainnet.base.org' }[net];
  const remote = async (method, params = []) => { const r = await (await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json(); if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; };
  assert.equal(Number(BigInt(await remote('eth_chainId'))), def.chainId, `upstream must be chain ${def.chainId}`);
  const head = Number(BigInt(await remote('eth_blockNumber')));
  const wanted = process.argv.slice(3);
  const assets = config.assets.filter(a => a.network === net && (wanted.length ? wanted.includes(a.symbol) : ['TSLA', 'AAPL', 'NVDA', 'SPY', 'TSLAc', 'AAPLc', 'NVDAc'].includes(a.symbol)));
  assert.ok(assets.length, 'No matching registry assets.');
  const registryAddress = net === 'robinhood' ? config.providers.robinhood.onchainFindings.registryAndBeacon.match(/0x[0-9a-fA-F]{40}/)[0] : null;
  const probeArtifact = compileContracts({ includeMocks: true })['tests/fixtures/EquityHolderProbe.sol'].EquityHolderProbe;
  const connection = await network.create({ network: 'localTest', override: { chainId: 31337, hardfork: 'cancun', forking: { url: rpc, blockNumber: head - 5 } } });
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const report = { scope: 'LOCAL FORK ONLY: nothing is sent to the public chain', network: net, chainId: def.chainId, block: head - 5, results: [] };
  try {
    await provider.send('hardhat_metadata', []); // refuse any provider without the local testing API
    for (const a of assets) {
      console.log(`\n== ${a.symbol} ${a.address}`);
      let holder = process.env.ELPIDA_EQUITY_HOLDER;
      if (!holder) {
        const topic = id('Transfer(address,address,uint256)'); let best = null, bestBal = 0n;
        const tk = new Contract(a.address, ERC, provider);
        let balErr = null;
        // Read the holder's balance from the upstream RPC at the fork block, so holder discovery does not depend on the fork's historical-read support.
        const balOf = async (addr) => { try { return BigInt(await remote('eth_call', [{ to: a.address, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, '0x' + (head - 5).toString(16)])); } catch (e) { balErr ??= e.message; return 0n; } };
        // 1) Ask the chain's Blockscout for the top holders (exact, one call). 2) Fall back to scanning recent Transfer logs.
        const explorer = (process.env.ELPIDA_EQUITY_EXPLORER ?? def.explorer ?? { base: 'https://base.blockscout.com' }[net] ?? '').replace(/\/$/, '');
        let explorerNote = '';
        if (explorer) {
          try {
            const r = await fetch(`${explorer}/api/v2/tokens/${a.address}/holders`, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; elpida-fork-check)' } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const items = (await r.json()).items ?? [];
            for (const it of items.slice(0, 10)) {
              const addr = it.address?.hash; if (!addr) continue;
              const b = await balOf(addr);
              if (b > 0n) { best = addr; bestBal = b; console.log(`  holder from explorer: ${addr}${it.address?.name ? ' (' + it.address.name + ')' : ''}`); break; }
            }
            if (!best) explorerNote = ` Explorer returned ${items.length} holder(s) but none had a balance on the fork.`;
          } catch (e) { explorerNote = ` Explorer lookup failed: ${e.message}.`; }
        }
        // Stock tokens trade rarely, so scan back in small chunks (public RPCs cap getLogs ranges) until a holder shows up.
        const CHUNK = 1000, MAX_CHUNKS = Number(process.env.ELPIDA_EQUITY_SCAN_CHUNKS ?? 300); let logErr = null, scanned = 0, logsSeen = 0;
        for (let i = 0; i < MAX_CHUNKS && !best; i++) {
          const to = head - i * CHUNK, from = to - CHUNK + 1; scanned++;
          const logs = await remote('eth_getLogs', [{ address: a.address, topics: [topic], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]).catch(e => { logErr = e.message; return []; });
          logsSeen += logs.length;
          const cands = [...new Set(logs.flatMap(l => [l.topics[1], l.topics[2]]).filter(Boolean).map(t => '0x' + t.slice(-40)))].filter(x => x !== '0x0000000000000000000000000000000000000000').slice(0, 25);
          for (const addr of cands) { const b = await balOf(addr); if (b > bestBal) { best = addr; bestBal = b; } }
          if (logErr && i >= 3 && !best) break; // the RPC keeps refusing the range: stop and say so
        }
        if (!best) console.log(`  no holder found.${explorerNote} Log scan: ${scanned} chunk(s) of ${CHUNK} blocks, ${logsSeen} transfer log(s) seen.${logErr ? ' Last RPC error: ' + logErr : ''}${balErr ? ' balanceOf error: ' + balErr + '.' : ''} Set ELPIDA_EQUITY_HOLDER=<address> (from the explorer's holders tab) and retry.`);
        holder = best;
      }
      if (!holder) { report.results.push({ symbol: a.symbol, pass: false, error: 'no holder found; set ELPIDA_EQUITY_HOLDER' }); console.log(`FAIL  ${a.symbol}: no holder found`); continue; }
      const res = await runTokenChecks({ provider, tokenAddress: a.address, holder, probeArtifact, expect: { symbol: a.symbol, decimals: a.decimals ?? undefined }, registryAddress });
      report.results.push({ symbol: a.symbol, ...res });
    }
    report.result = report.results.every(r => r.pass) ? 'PASS' : 'FAIL';
  } finally {
    mkdirSync('backups/equity-fork', { recursive: true });
    writeFileSync(`backups/equity-fork/${net}-report.json`, JSON.stringify(report, null, 2));
    provider.destroy(); await connection.close();
    console.log(`\nResult: ${report.result ?? 'ERROR'}. Report: backups/equity-fork/${net}-report.json`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
