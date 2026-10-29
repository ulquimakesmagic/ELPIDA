import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';
import { inspectOndoControls } from './lib/ondo-controls.mjs';
import { compareOndoControls } from './lib/ondo-control-drift.mjs';

const [net = 'ethereum', symbol = 'NVDAon', baselinePath] = process.argv.slice(2);
let proxy;
try {
  const config = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const asset = config.assets.find(a => a.network === net && a.provider === 'ondo' && a.symbol === symbol);
  if (!asset || !['ethereum', 'bnb'].includes(net)) throw new Error();
  const rpc = process.env[`ELPIDA_EQUITY_FORK_RPC_${net.toUpperCase()}`] ?? process.env.ELPIDA_EQUITY_FORK_RPC;
  const snapshot = await forkSnapshot(rpc, config.networks[net].chainId, process.env.ELPIDA_EQUITY_FORK_BLOCK);
  proxy = await createForkRpc({ rpc, snapshot, cacheDir: 'cache/equity-rpc' });
  const report = await inspectOndoControls({ asset, snapshot, request: proxy.request });
  mkdirSync('backups/equity-fork', { recursive: true });
  const output = `backups/equity-fork/${net}-ondo-${symbol}-controls.json`;
  // Read baseline before writing the latest report; never silently replace accepted evidence.
  const drift = baselinePath ? compareOndoControls(JSON.parse(readFileSync(baselinePath, 'utf8')), report) : null;
  if (baselinePath && resolve(baselinePath) === resolve(output)) throw new Error();
  writeFileSync(output, JSON.stringify(report, null, 2));
  if (drift) {
    writeFileSync(output.replace(/\.json$/, '-drift.json'), JSON.stringify(drift, null, 2));
    console.log(`Control comparison: ${drift.status}; ${drift.changes.length} changed fields; ${drift.unverified.length} fields remain unverified.`);
    if (drift.changes.length) process.exitCode = 2;
  }
  console.log(`Read-only inspection: ${net}/${symbol}, block ${snapshot.number}; identity matches: ${report.identityMatches}; issuer controls remain UNVERIFIED. Report: ${output}`);
  if (!report.identityMatches || !report.codePresent) process.exitCode = 1;
} catch { console.error('Inspection failed; verify RPC access and the registered EVM asset. Endpoint details omitted.'); process.exitCode = 1; }
finally { if (proxy) await proxy.close(); }
