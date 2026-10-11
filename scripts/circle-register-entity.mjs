// Run through npm run circle:setup; never paste this JavaScript into PowerShell.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = join(root, '.env');
const privateDirectory = join(root, 'local-data', 'circle-entity-setup');
const pendingPath = join(privateDirectory, 'pending-secret.env');
const recoveryDirectory = join(privateDirectory, 'recovery');

async function main() {
  if (!existsSync(envPath)) throw new Error('Create .env in elpida-v1 and add CIRCLE_API_KEY first.');
  process.loadEnvFile(envPath);
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  if (!/^TEST_API_KEY:/.test(apiKey ?? '')) throw new Error('Add your Circle TEST API key to CIRCLE_API_KEY in elpida-v1/.env first. Never use a live API key.');
  const existing = readFileSync(envPath, 'utf8');
  if (process.env.CIRCLE_ENTITY_SECRET?.trim() || /^\s*CIRCLE_ENTITY_SECRET\s*=\s*[^\s#]+/m.test(existing)) throw new Error('An entity secret is already configured. Preserving it; no new secret was registered.');
  if (process.argv.includes('--check')) { console.log('Setup prerequisites passed. No registration request was sent.'); return; }

  mkdirSync(recoveryDirectory, { recursive: true });
  // Save before the request: a timeout must never lose the secret or generate a different one on retry.
  if (!existsSync(pendingPath)) writeFileSync(pendingPath, 'CIRCLE_ENTITY_SECRET=' + randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  const entitySecret = readFileSync(pendingPath, 'utf8').match(/^CIRCLE_ENTITY_SECRET=([a-f0-9]{64})$/m)?.[1];
  if (!entitySecret) throw new Error('Saved pending secret is unreadable. Restore it before continuing.');
  let response;
  try {
    response = await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: recoveryDirectory });
  } catch {
    throw new Error('Circle registration did not finish. Check your API key and whether an entity secret is already registered in Circle Console. The pending secret is preserved in local-data/circle-entity-setup/pending-secret.env. Do not rotate or replace it after an uncertain response.');
  }
  if (!response.data?.recoveryFile) throw new Error('Circle did not return a recovery file. Contact Circle support before retrying; the pending secret is preserved.');
  // Keep our own recovery copy even if the SDK could not save its generated file.
  const backup = join(recoveryDirectory, 'circle-recovery-' + randomBytes(8).toString('hex') + '.dat');
  writeFileSync(backup, response.data.recoveryFile, { flag: 'wx', mode: 0o600 });
  const latest = readFileSync(envPath, 'utf8');
  if (/^\s*CIRCLE_ENTITY_SECRET\s*=\s*[^\s#]+/m.test(latest)) throw new Error('The .env secret changed during setup. It was preserved. Registered secret is in the pending file.');
  const line = 'CIRCLE_ENTITY_SECRET=' + entitySecret;
  if (/^\s*CIRCLE_ENTITY_SECRET\s*=/m.test(latest)) writeFileSync(envPath, latest.replace(/^\s*CIRCLE_ENTITY_SECRET\s*=.*$/m, line), { mode: 0o600 });
  else appendFileSync(envPath, '\n' + line + '\n', { mode: 0o600 });
  console.log('Entity secret registered and saved to elpida-v1/.env. Secret values were not printed.');
  console.log('Recovery files: local-data/circle-entity-setup/recovery. Store a copy securely outside this project.');
  console.log('Copy CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET and ELPIDA_CIRCLE_ADMIN_TOKEN from .env into Railway Variables.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
