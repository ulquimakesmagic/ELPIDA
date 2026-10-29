// Supervises a local fork rehearsal behind a read-only, block-hash scoped RPC cache.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';

export async function main() {
  const [net, symbol, providerId] = process.argv.slice(2).filter(x => x !== '--fresh');
  const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const def = config.networks[net];
  const asset = config.assets.find(a => a.network === net && a.provider === providerId && a.symbol === symbol);
  if (!asset || !def?.chainId || !(net === 'robinhood' || (providerId === 'ondo' && ['ethereum', 'bnb'].includes(net)))) throw new Error('Choose a registered EVM stock: ethereum NVDAon ondo (or bnb / legacy robinhood).');
  const rpc = process.env[`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`] ?? process.env.ELPIDA_EQUITY_FORK_RPC ?? def.rpc;
  if (!rpc) throw new Error('Configure an archive RPC locally.');
  const timeoutSec = Number(process.env.ELPIDA_EQUITY_FORK_TIMEOUT_SEC ?? 300);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new Error('Fork timeout must be 1–3600 seconds.');
  const pinPath = `cache/equity-rpc/${net}-${providerId}-${symbol}-pin.json`;
  const previous = !process.argv.includes('--fresh') && existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, 'utf8')) : null;
  if (previous && (previous.chainId !== def.chainId || previous.token !== asset.address)) throw new Error('Stored fork pin has a different chain or asset. Use --fresh.');
  const snapshot = await forkSnapshot(rpc, def.chainId, process.env.ELPIDA_EQUITY_FORK_BLOCK ?? previous?.number);
  if (previous && process.env.ELPIDA_EQUITY_FORK_BLOCK == null && previous.hash !== snapshot.hash) throw new Error('Stored block hash changed. Use --fresh to select new state.');
  mkdirSync('cache/equity-rpc', { recursive: true });
  writeFileSync(pinPath, JSON.stringify({ ...snapshot, token: asset.address }, null, 2));
  console.log(`Local fork: ${net}/${providerId}/${symbol}, block ${snapshot.number}, hash ${snapshot.hash}`);
  const proxy = await createForkRpc({ rpc, snapshot, cacheDir: 'cache/equity-rpc' });
  const reportPath = `backups/equity-fork/${net}-${providerId}-${symbol}-${process.env.ELPIDA_EQUITY_RESTRICTIONS === '1' ? 'restrictions' : 'lifecycle'}-report.json`;
  mkdirSync('backups/equity-fork', { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ scope: 'LOCAL FORK ONLY', network: net, provider: providerId, symbol, token: asset.address, block: snapshot.number, blockHash: snapshot.hash, result: 'RUNNING', results: [] }, null, 2));
  let timedOut = false, child;
  const redact = s => String(s).replaceAll(rpc, '[RPC redacted]').replaceAll(new URL(rpc).pathname.split('/').filter(Boolean).at(-1) ?? rpc, '[endpoint component redacted]');
  try {
    child = spawn(process.execPath, ['scripts/equity-lifecycle-fork.mjs', net, symbol, providerId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELPIDA_EQUITY_FORK_RPC: proxy.url, [`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`]: proxy.url, ELPIDA_EQUITY_FORK_BLOCK: String(snapshot.number) } });
    child.stdout.on('data', chunk => process.stdout.write(redact(chunk)));
    child.stderr.on('data', chunk => process.stderr.write(redact(chunk)));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSec * 1000);
    const progress = setInterval(() => console.log('Archive cache:', JSON.stringify(proxy.stats())), 30000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', () => reject(new Error('Could not start the local fork runner.'))); child.once('exit', resolve); }); }
    catch { code = 1; }
    finally { clearTimeout(timer); clearInterval(progress); }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (timedOut || report.result === 'RUNNING') { report.result = 'INCOMPLETE'; report.error = timedOut ? 'Local rehearsal time limit reached; rerun to reuse the pinned cache.' : 'Runner exited before completing the report.'; }
    if (code !== 0 && report.result === 'PASS') { report.result = 'INCOMPLETE'; report.error = 'Runner exited unsuccessfully after its last check.'; }
    report.blockHash = snapshot.hash; report.rpcCache = proxy.stats();
    if (report.error) report.error = redact(report.error);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Result: ${report.result}; completed checks: ${report.results.length}; report: ${reportPath}`);
    process.exitCode = code === 0 && report.result === 'PASS' ? 0 : 1;
  } finally { await proxy.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error('Cached fork setup failed; check RPC access, registry selection and pinned block. Endpoint details omitted.'); process.exitCode = 1; }
}
