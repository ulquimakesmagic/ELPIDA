// Verifies the transaction hashes a checklist claims against the chains they name.
//
// MAINNET_CHECKLIST records transactions as proof ("A2 ... Done (21 Oct): ... 0x284c..."). Those hashes are the
// strongest evidence in the repository and the only claims a stranger could check without trusting us - so check them.
// Any full 0x + 64-hex hash is looked up with eth_getTransactionReceipt across the configured testnets; the report
// records which chain answered, the block, the status and whether the transaction succeeded.
//
//   node scripts/verify-checklist.mjs                       # docs/MAINNET_CHECKLIST_2026-10-19.md
//   node scripts/verify-checklist.mjs docs/MULTICHAIN_TESTNETS.md --out docs/evidence/checklist-x.json
//
// Exit 1 when a hash is not found on any configured chain, or is found reverted. Truncated hashes (0x27a4...0e4b)
// cannot be checked and are listed as such rather than silently ignored.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evmTestnets } from '../packages/core/networks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_SOURCE = 'docs/MAINNET_CHECKLIST_2026-10-19.md';

/** Full hashes (checkable) and truncated ones (not), with the checklist row each belongs to. */
export function parseChecklist(text) {
  const hashes = new Map();
  const truncated = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    const row = line.match(/^\|\s*([A-Z]\d+)\s*\|/);
    const label = row ? row[1] : null;
    for (const match of line.matchAll(/0x[a-fA-F0-9]{64}\b/g)) {
      const hash = match[0].toLowerCase();
      if (!hashes.has(hash)) hashes.set(hash, { hash, label, line: index + 1 });
    }
    for (const match of line.matchAll(/0x[a-fA-F0-9]{2,12}\u2026[a-fA-F0-9]{2,12}/g)) {
      if (!truncated.has(match[0])) truncated.set(match[0], { hash: match[0], label, line: index + 1 });
    }
  });
  return { hashes: [...hashes.values()], truncated: [...truncated.values()] };
}

/** JSON-RPC POST with a timeout, so one slow public endpoint cannot stall the report. */
export async function rpcCall(url, method, params, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? 'rpc error');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks each hash up on every configured chain until one answers.
 * @param {{hashes: {hash: string, label: string|null, line: number}[], networks: object[], call?: Function, wait?: Function}} input
 */
export async function verifyHashes({ hashes, networks, call = rpcCall, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const results = [];
  for (const entry of hashes) {
    let found = null;
    const errors = [];
    for (const net of networks) {
      try {
        const receipt = await call(net.rpcUrl, 'eth_getTransactionReceipt', [entry.hash]);
        if (receipt) {
          found = {
            chain: net.key,
            chainId: net.chainId,
            block: Number(receipt.blockNumber),
            status: Number(receipt.status),
            from: receipt.from,
            to: receipt.to,
            gasUsed: Number(receipt.gasUsed ?? 0),
          };
          break;
        }
      } catch (error) {
        errors.push(`${net.key}: ${error.message}`);
      }
      await wait(150);
    }
    results.push({ ...entry, ...(found ?? {}), verified: Boolean(found && found.status === 1), chainsTried: networks.length, ...(found ? {} : { error: 'not found on any configured chain', errors }) });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const source = args.find(arg => !arg.startsWith('--')) ?? DEFAULT_SOURCE;
  const outFlag = args.findIndex(arg => arg === '--out');
  const stamp = new Date().toISOString().slice(0, 10);
  const out = outFlag >= 0 ? args[outFlag + 1] : join(root, 'docs/evidence/checklist-verification-' + stamp + '.json');

  const { hashes, truncated } = parseChecklist(readFileSync(join(root, source), 'utf8'));
  if (!hashes.length) {
    console.error(`no full transaction hashes found in ${source}`);
    process.exit(2);
  }

  console.log(`checking ${hashes.length} hash(es) from ${source} against ${evmTestnets.length} chain(s)\n`);
  const results = await verifyHashes({ hashes, networks: evmTestnets });

  for (const result of results) {
    const where = result.chain ? `${result.chain} @ ${result.block}` : 'not found';
    console.log(`  ${result.verified ? 'ok  ' : 'FAIL'} ${result.label ?? '-'}  ${result.hash.slice(0, 12)}…  ${where}`);
  }

  const report = {
    kind: 'checklist-verification',
    source,
    checkedAt: new Date().toISOString(),
    networks: evmTestnets.map(net => ({ key: net.key, chainId: net.chainId })),
    counts: { hashes: results.length, verified: results.filter(r => r.verified).length, failed: results.filter(r => !r.verified).length, truncated: truncated.length },
    truncated,
    results,
  };
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.counts.verified}/${report.counts.hashes} verified, ${report.counts.truncated} truncated hash(es) cannot be checked`);
  console.log(`report: ${out.startsWith(root) ? out.slice(root.length).replace(/\\/g, '/') : out}`);
  process.exit(report.counts.failed ? 1 : 0);
}
