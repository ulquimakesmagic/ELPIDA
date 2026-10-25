// Builds the package an auditor receives: the sources, the scope document that says what to read, the static-analysis
// report, the evidence, and a manifest of hashes. It used to copy every test and asset while omitting the brief itself
// and still calling the scope "Base model-9 review".
//
//   npm run security:package          -> backups/security-review/<timestamp>/
//
// Exported for tests: the file selection and the manifest are pure functions of `git ls-files` plus the working tree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The nine EVM files docs/AUDIT_SCOPE.md puts in scope. tests/claims.test.mjs checks this list against the brief. */
export const AUDIT_SCOPE = [
  'contracts/evm/src/ElpidaAtomicDexFactory.sol',
  'contracts/evm/src/ElpidaDexFactory.sol',
  'contracts/evm/src/ElpidaUsdPricing.sol',
  'contracts/evm/src/ElpidaDexCurve.sol',
  'contracts/evm/src/ElpidaV3MigrationAdapter.sol',
  'contracts/evm/src/ElpidaV3FeeLocker.sol',
  'contracts/evm/src/ElpidaFeeSplitter.sol',
  'contracts/evm/src/ElpidaToken.sol',
  'contracts/evm/src/ElpidaInterfaces.sol',
];

/** Documents an auditor needs before reading code, plus the runbooks the brief references. */
const DOCS = new Set([
  'docs/AUDIT_SCOPE.md',
  'docs/F1_GRADUATION_BLOCKING.md',
  'docs/ASSURANCE_GATES.md',
  'docs/MAINNET_CHECKLIST_2026-10-19.md',
  'docs/MAINNET_READINESS.md',
  'docs/HUMAN_ACTIONS.md',
  'docs/SECURITY_REVIEW_2026-10-21.md',
  'docs/STORAGE_OPERATIONS.md',
  'docs/BASE_MAINNET_REVIEW.md',
  'docs/LAUNCH_CONFIRMATION.md',
  'docs/TESTNET_LIFECYCLE_VERIFICATION.md',
  'docs/VIRTUAL_CURVE_AND_PAIRS.md',
  'docs/MODEL_10.md',
  'docs/TOKEN_METADATA.md',
  'docs/TRADING_PAIRS.md',
]);

/** Committed evidence: the fork lifecycle report, the checklist verification and the Slither output. */
const isEvidence = path => /^docs\/(evidence|security)\/[^/]+\.json$/.test(path);
const isEvmSource = path => /^contracts\/evm\/(src|testnet)\/[^/]+\.sol$/.test(path);
const isSolana = path => /^contracts\/solana\/(programs\/[^/]+\/(src\/[^/]+\.rs|Cargo\.toml)|Cargo\.toml|Cargo\.lock|README\.md)$/.test(path);
const isApp = path => /^apps\/(api|web)\/.*\.(mjs|html|css|svg|png|woff2|webmanifest|txt|json)$/.test(path);
const isPackage = path => /^packages\/.*\.(mjs|json)$/.test(path);
const isTest = path => /^tests\/.*\.(mjs|sol)$/.test(path);
const isScript = path => /^scripts\/.*\.mjs$/.test(path);
const isRoot = path => ['package.json', 'package-lock.json', 'hardhat.config.js'].includes(path);

export function selectPackageFiles(files) {
  return files.filter(path =>
    isEvmSource(path) || isSolana(path) || isApp(path) || isPackage(path) || isTest(path) || isScript(path) ||
    isRoot(path) || DOCS.has(path) || isEvidence(path));
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const tracked = git('ls-files').split('\n').filter(Boolean);
  const files = selectPackageFiles(tracked);

  const missing = AUDIT_SCOPE.filter(path => !files.includes(path));
  if (missing.length) throw new Error(`the audit scope is incomplete: ${missing.join(', ')}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = join(root, 'backups', 'security-review', stamp);
  mkdirSync(output, { recursive: true });

  const hashes = [];
  for (const path of files) {
    const source = resolve(root, path), destination = resolve(output, path);
    if (!source.startsWith(root) || !destination.startsWith(output + '\\') && !destination.startsWith(output + '/')) {
      throw new Error('Export path escaped the selected directory');
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    hashes.push({ path, sha256: sha256(source), inAuditScope: AUDIT_SCOPE.includes(path) });
  }

  // Program binaries stay out of the package, but their hashes are part of the record.
  const binaries = tracked.filter(path => /^contracts\/solana\/build\/[^/]+\.so$/.test(path))
    .map(path => ({ path, sha256: sha256(resolve(root, path)), bytes: readFileSync(resolve(root, path)).length }));

  const manifest = {
    createdAt: new Date().toISOString(),
    commit: git('rev-parse', 'HEAD'),
    workingTreeChanges: git('status', '--porcelain').split('\n').filter(Boolean),
    compiler: solc.version(),
    settings: { optimizer: { enabled: true, runs: 1 }, evmVersion: 'shanghai' },
    scope: 'Model 10 atomic factory (ElpidaAtomicDexFactory) and what it deploys. docs/AUDIT_SCOPE.md is the brief; the nine in-scope EVM files are flagged inAuditScope. The Solana program is a separate engagement and is included as context.',
    auditScope: AUDIT_SCOPE,
    binaries,
    exclusions: ['credentials', 'private keys', 'recovery files', 'local data', 'fork caches', 'backups', 'node_modules'],
    files: hashes,
  };
  writeFileSync(join(output, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(output, 'README.txt'), [
    'Start with docs/AUDIT_SCOPE.md: it states the scope, the trust model and the findings, and MANIFEST.json flags',
    'the nine in-scope EVM files with inAuditScope: true.',
    '',
    'Also here: docs/security/slither-2026-10-25.json (the static-analysis run the brief describes),',
    'docs/evidence/ (a verified fork lifecycle and a chain-checked transaction list), and docs/F1_GRADUATION_BLOCKING.md',
    '(the griefing decision with measurements).',
    '',
    'Verify MANIFEST.json hashes, install locked dependencies with npm ci, and run npm run test:gate. The package is a',
    'review snapshot, not an audit certificate. Program binaries are not copied; MANIFEST.json records their SHA256.',
    'No user secrets are included.',
  ].join('\n') + '\n');

  console.log(JSON.stringify({ output, commit: manifest.commit, files: files.length, inScope: AUDIT_SCOPE.length, compiler: manifest.compiler }));
}
