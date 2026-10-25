// The audit package must contain the brief it refers to, the findings memo and the evidence - and nothing secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AUDIT_SCOPE, selectPackageFiles } from '../scripts/security-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the package carries the brief, the findings, the evidence and the Solana sources', () => {
  const expected = [
    'docs/AUDIT_SCOPE.md',
    'docs/F1_GRADUATION_BLOCKING.md',
    'docs/ASSURANCE_GATES.md',
    'docs/evidence/base-sepolia-fork-48075531.json',
    'docs/security/slither-2026-10-25.json',
    'contracts/solana/programs/elpida_launchpad/src/lib.rs',
    'apps/api/server.mjs',
    'packages/core/curve-model.mjs',
    'tests/claims.test.mjs',
    'scripts/compile.mjs',
    ...AUDIT_SCOPE,
  ];
  const selected = selectPackageFiles(expected);
  for (const path of expected) assert.ok(selected.includes(path), `${path} must be packaged`);
});

test('nothing secret, local or binary is packaged', () => {
  const risky = [
    '.env',
    '.env.backup-key',
    'contracts/solana/keys/elpida_launchpad-keypair.json',
    'local-data/public-84532-0x00.sqlite',
    'backups/security-review/x/MANIFEST.json',
    'contracts/solana/build/elpida_launchpad.so',
    'node_modules/ethers/package.json',
  ];
  assert.deepEqual(selectPackageFiles(risky), []);
});

test('the packaged scope is exactly what the brief lists', () => {
  const brief = readFileSync(join(root, 'docs/AUDIT_SCOPE.md'), 'utf8');
  const listed = [...brief.matchAll(/^\|\s*`(contracts\/evm\/src\/[^`]+\.sol)`\s*\|/gm)].map(match => match[1]);
  assert.deepEqual([...AUDIT_SCOPE].sort(), listed.sort(), 'scripts/security-package.mjs and the brief disagree');
  for (const path of AUDIT_SCOPE) assert.ok(existsSync(join(root, path)), `${path} is in scope but missing`);
});
