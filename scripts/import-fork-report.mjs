// Imports a fork report written before docs/evidence existed, so older runs become reviewable too.
//
//   node scripts/import-fork-report.mjs backups/base-fork/lifecycle-report.json base-sepolia 84532
//
// The report is sanitised and stamped with its source path and the file's own modification time, so the imported
// evidence says where it came from and when it was produced rather than pretending to be a fresh run.
import { readFileSync, statSync } from 'node:fs';
import { writeEvidence } from './evidence.mjs';

const [source, network, chainId] = process.argv.slice(2);
if (!source || !network) {
  console.error('usage: node scripts/import-fork-report.mjs <report.json> <network> [chainId]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(source, 'utf8'));
const result = writeEvidence(
  { ...report, kind: 'imported-local-fork', source, recordedAt: statSync(source).mtime.toISOString() },
  { network, chainId: chainId ? Number(chainId) : undefined },
);
console.log(result);
