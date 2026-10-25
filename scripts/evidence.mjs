// Publishes a fork-lifecycle report where a reviewer can read it: `docs/evidence/`.
//
// The fork scripts used to write only to `backups/`, which .gitignore covers, so every "13/13 PASS" claim in the
// checklist rested on a file the repository could not show. This module writes a sanitised copy that is safe to
// commit: no RPC URLs with credentials, no key material, BigInts as strings, and provenance recorded inside the file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const EVIDENCE_DIR = join(root, 'docs', 'evidence');

/** Keys whose values must never reach a committed file. `token` is an address and is deliberately not listed. */
const SECRET_KEYS = /^(privatekey|private_key|secret|mnemonic|keypair|deployerkey|apikey|api_key|jwt|authorization)$/i;

/** Removes credentials from URLs and any key material a caller may have attached to an error. */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) continue;
      clean[key] = scrub(entry);
    }
    return clean;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    return value
      .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1redacted@')
      .replace(/([?&](?:api[-_]?key|key|token|apikey)=)[^&\s"]+/gi, '$1REDACTED');
  }
  return value;
}

/** `base-sepolia-fork-48289973.json`, or with `--dated` style suffixes when a network is checked more than once. */
export function evidenceName(report, { network, block, date } = {}) {
  const chain = network ?? report.network ?? report.chainKey ?? 'chain';
  const height = block ?? report.block ?? 'unknown';
  const stampValue = date ?? report.date;
  const stamp = stampValue === undefined ? '' : `-${stampValue}`;
  return `${String(chain).toLowerCase()}-fork-${height}${stamp}.json`;
}

/**
 * Writes a sanitised report and returns its repo-relative path.
 * @param {object} report   the report the fork script produced
 * @param {{network?:string, chainId?:number, date?:string, dir?:string}} [options]
 */
export function writeEvidence(report, options = {}) {
  const dir = options.dir ?? EVIDENCE_DIR;
  const clean = scrub(report);
  const published = {
    kind: 'local-fork',
    ...clean,
    ...(options.network ? { network: options.network } : {}),
    ...(options.chainId ? { chainId: options.chainId } : {}),
    recordedAt: clean.recordedAt ?? new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, evidenceName(published, options));
  writeFileSync(path, `${JSON.stringify(published, null, 2)}\n`);
  // Repo-relative when the report lives in the repository, absolute when a caller kept it elsewhere (tests, temp).
  return path.startsWith(root) ? path.slice(root.length).replace(/\\/g, '/') : path;
}
