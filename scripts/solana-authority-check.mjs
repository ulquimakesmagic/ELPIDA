#!/usr/bin/env node
// Reads the on-chain authority of the Elpida Solana program. Read-only: it never signs, deploys or upgrades.
//
//   node scripts/solana-authority-check.mjs                       # devnet program from deployments/solana-devnet.json
//   node scripts/solana-authority-check.mjs --program <id> --rpc <url>
//   node scripts/solana-authority-check.mjs --require-multisig    # exits 1 when the upgrade authority is one keypair
//
// The upgrade authority can replace the program, and with it every curve reserve, LP position and distributor vault,
// so a mainnet release must not run with a single key in that slot (audit finding SOL-UPG).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const record = (() => {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../deployments/solana-devnet.json', import.meta.url)), 'utf8')); } catch { return {}; }
})();

const rpc = value('rpc') ?? process.env.SOLANA_RPC_URL ?? record.rpcUrl ?? 'https://api.devnet.solana.com';
const programId = value('program') ?? record.programId;
if (!programId) { console.error('{"error":"PROGRAM_REQUIRED"}'); process.exit(2); }

/** One JSON-RPC call. No retries: a read that fails should surface, not be retried behind the operator's back. */
async function call(method, params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** base64 account data as a Buffer, or null when the account does not exist. */
async function account(address) {
  const result = await call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  const info = result?.value;
  if (!info) return null;
  return { owner: info.owner, lamports: info.lamports, data: Buffer.from(info.data[0], 'base64') };
}

const base58 = bytes => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + (bytes.length ? bytes.toString('hex') : '0'));
  let out = '';
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte === 0) out = '1' + out; else break; }
  return out || '1';
};

const run = async () => {
  const program = await account(programId);
  if (!program) throw new Error(`program ${programId} not found at ${rpc}`);

  const out = { rpc, programId, loader: program.owner, upgradeAuthority: null, programData: null, authorityOwner: null, multisig: null, notes: [] };

  if (program.owner !== BPF_LOADER_UPGRADEABLE) {
    out.notes.push('The program is not owned by the upgradeable loader: it cannot be upgraded, so there is no upgrade authority to move.');
  } else {
    // Upgradeable loader program account: 4-byte enum (2 = Program), then the ProgramData address.
    const programDataAddress = base58(program.data.subarray(4, 36));
    out.programData = programDataAddress;
    const data = await account(programDataAddress);
    if (!data) throw new Error('program data account missing');
    // ProgramData: 4-byte enum (3), 8-byte slot, 1-byte Option tag, then the authority pubkey when the tag is 1.
    const hasAuthority = data.data[12] === 1;
    if (!hasAuthority) {
      out.notes.push('The upgrade authority has been revoked: nobody can upgrade the program.');
    } else {
      const authority = base58(data.data.subarray(13, 45));
      out.upgradeAuthority = authority;
      const authorityAccount = await account(authority);
      out.authorityOwner = authorityAccount?.owner ?? null;
      // A keypair is owned by the system program and holds no data of its own (unless it is a PDA, which cannot sign
      // by itself). A multisig lives in a program account and is owned by that program.
      const isSystemOwned = out.authorityOwner === SYSTEM_PROGRAM;
      const hasData = (authorityAccount?.data.length ?? 0) > 0;
      out.multisig = !isSystemOwned;
      if (isSystemOwned) out.notes.push('The upgrade authority is a system-owned keypair: one key can replace the program and move every vault.');
      else out.notes.push(`The upgrade authority is owned by ${out.authorityOwner}${hasData ? ' (a program account, e.g. a multisig or a PDA)' : ''}.`);
    }
  }

  console.log(JSON.stringify(out, null, 2));

  if (flag('require-multisig') && out.upgradeAuthority && out.multisig === false) {
    console.error(JSON.stringify({ refused: 'UPGRADE_AUTHORITY_NOT_MULTISIG', authority: out.upgradeAuthority }));
    process.exit(1);
  }
};

run().catch(error => { console.error(JSON.stringify({ error: 'CHECK_FAILED', detail: String(error.message).slice(0, 200) })); process.exit(2); });
