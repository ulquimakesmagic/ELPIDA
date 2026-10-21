// Scans the repository for committed secrets (mainnet checklist C6). Prints file, line and pattern name only, never
// the matched text. Exit code 1 when anything is found.
//   npm run security:scan            tracked files in the working tree
//   npm run security:scan -- --history   every added line in every commit on every branch (needs a full clone)
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const PATTERNS = {
  pem_private_key: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  assigned_hex_key: /(private[_ ]?key|secret|mnemonic|seed[_ ]?phrase|deployer[_ ]?key)["']?\s*[:=]\s*["']?(0x)?[0-9a-f]{64}\b/i,
  solana_keypair_array: /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/,
  api_key_in_url: /[?&](api[-_]?key|apikey|key|token)=[A-Za-z0-9\-_]{20,}/i,
  jwt: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  aws_access_key: /\bAKIA[0-9A-Z]{16}\b/,
  github_token: /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  circle_api_key: /\b(TEST|LIVE)_API_KEY:[A-Za-z0-9]{8,}:[A-Za-z0-9]{8,}/,
  stripe_style_key: /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
  mnemonic_phrase: /mnemonic["']?\s*[:=]\s*["'](?:[a-z]+\s+){11,23}[a-z]+["']/i,
};
// Hardhat/Anvil default accounts and the standard test mnemonic are public; they are reported separately, not as findings.
const PUBLIC_TEST_KEYS = /ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80|59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d|test test test test test test test test test test test junk/i;
const SKIP = /(^|\/)node_modules\/|\.(png|jpe?g|gif|webp|ico|woff2?|so|sqlite|lock|pdf)$/i;

/** Pattern names found in one line of text (never the text itself). */
export function scanLine(line) {
  const text = line.length > 20000 ? line.slice(0, 20000) : line, found = [];
  for (const [name, rx] of Object.entries(PATTERNS)) if (rx.test(text)) found.push(PUBLIC_TEST_KEYS.test(text) ? 'public_test_key' : name);
  return found;
}

export function scanText(name, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => { for (const kind of scanLine(line)) hits.push({ file: name, line: i + 1, kind }); });
  return hits;
}

function scanTree(cwd) {
  const files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' }).split('\n').filter(f => f && !SKIP.test(f));
  return files.flatMap(f => { try { return scanText(f, readFileSync(`${cwd}/${f}`, 'utf8')); } catch { return []; } });
}

async function scanHistory(cwd) {
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' }).trim() === 'true';
  const git = spawn('git', ['log', '--all', '-p', '--no-color', '--unified=0', '--format=COMMIT %h'], { cwd });
  const hits = []; let commit = '', file = '';
  for await (const line of createInterface({ input: git.stdout })) {
    if (line.startsWith('COMMIT ')) { commit = line.slice(7); continue; }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    if (line.startsWith('+') && !line.startsWith('+++') && file && !SKIP.test(file)) for (const kind of scanLine(line.slice(1))) hits.push({ file: `${commit}:${file}`, line: 0, kind });
  }
  return { hits, shallow };
}

export async function runScan({ cwd = process.cwd(), history = false } = {}) {
  const { hits, shallow } = history ? await scanHistory(cwd) : { hits: scanTree(cwd), shallow: false };
  const findings = hits.filter(h => h.kind !== 'public_test_key'), publicTestKeys = hits.length - findings.length;
  return { findings, publicTestKeys, shallow };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const history = process.argv.includes('--history');
  const { findings, publicTestKeys, shallow } = await runScan({ history });
  if (shallow) console.log('WARNING: this clone is shallow; run `git fetch --unshallow` for a complete history scan.');
  console.log(`Secret scan (${history ? 'full history' : 'working tree'}): ${findings.length} finding(s); ${publicTestKeys} public test key reference(s) ignored.`);
  for (const f of findings) console.log(`  ${f.kind}  ${f.file}${f.line ? ':' + f.line : ''}`);
  process.exit(findings.length ? 1 : 0);
}
