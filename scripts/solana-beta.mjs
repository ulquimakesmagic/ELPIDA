// Mainnet beta administration for the Elpida Solana program (see docs/MAINNET_BETA.md).
//
//   node scripts/solana-beta.mjs status                         # gate, allowlist, upgrade authority
//   node scripts/solana-beta.mjs allow <creator> [<creator>…]   # signed by the beta admin key
//   node scripts/solana-beta.mjs revoke <creator> [<creator>…]
//   node scripts/solana-beta.mjs set-gate --admin <wallet> --enabled true|false
//   node scripts/solana-beta.mjs transfer-authority --to <Squads vault> --yes
//   node scripts/solana-beta.mjs prepare-upgrade --multisig <Squads vault>
//
// Options: --cluster mainnet|devnet|localnet (default mainnet), --rpc <url> (or SOLANA_RPC_URL),
// --keypair <file> (default local-data/solana-deployer-<cluster>.json).
// When the upgrade authority is a multisig, `set-gate --export` prints the instruction for Squads
// instead of sending it, and `prepare-upgrade` stages a buffer the multisig can approve.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { createElpidaSolana, LOADER_V3, DISCRIMINATORS } from '../packages/solana/client.mjs';
import { send, transferUpgradeAuthority, prepareUpgradeBuffer, closeStaleBuffers } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  cluster: { type: 'string', default: 'mainnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  admin: { type: 'string' }, enabled: { type: 'string' }, to: { type: 'string' }, multisig: { type: 'string' },
  export: { type: 'boolean', default: false }, yes: { type: 'boolean', default: false }, rate: { type: 'string' },
} });
const [command, ...targets] = positionals;
const cluster = args.cluster;
if (!['mainnet', 'devnet', 'localnet'].includes(cluster)) throw new Error('--cluster must be mainnet, devnet or localnet');
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (cluster === 'localnet' ? 'http://127.0.0.1:8899' : cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : solanaDevnet.rpcUrl);
const recordPath = `${root}local-data/solana-${cluster}.json`;
if (!existsSync(recordPath)) throw new Error(`No deployment record at ${recordPath}. Run npm run solana:deploy -- --cluster ${cluster} first.`);
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const programId = new web3.PublicKey(record.programId);
const connection = new web3.Connection(rpcUrl, 'confirmed');
const client = createElpidaSolana(web3, programId);
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${cluster === 'localnet' ? '-localnet' : cluster === 'mainnet' ? '-mainnet' : ''}.json`;
const signer = () => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
const key = text => { try { return new web3.PublicKey(String(text).trim()); } catch { throw new Error(`Not a Solana address: ${text}`); } };

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
async function upgradeAuthority() {
  const info = await connection.getAccountInfo(client.programDataAddress);
  if (!info || info.owner.toBase58() !== LOADER_V3) throw new Error('Program data not found on this cluster.');
  return info.data[12] === 1 ? new web3.PublicKey(info.data.subarray(13, 45)) : null;
}
/** Prints an instruction for a multisig to approve (Squads transaction builder: add it as a custom instruction). */
async function exportFor(authority, instruction) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new web3.Transaction({ feePayer: authority, recentBlockhash: blockhash }).add(instruction).compileMessage();
  console.log('\nInstruction for the multisig (program, accounts, data):');
  console.log(JSON.stringify({ programId: instruction.programId.toBase58(), accounts: instruction.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: base58(instruction.data) }, null, 2));
  console.log(`\nSerialized message (base58, fee payer = multisig): ${base58(message.serialize())}`);
  console.log('Check every account in the multisig app before approving.');
}

if (command === 'status') {
  const [gateInfo, authority] = await Promise.all([connection.getAccountInfo(client.betaGatePda), upgradeAuthority()]);
  const gate = client.decodeBetaGate(gateInfo?.data);
  console.log(`Cluster:            ${cluster}`);
  console.log(`Program:            ${programId.toBase58()}`);
  console.log(`Upgrade authority:  ${authority ? authority.toBase58() : 'none (immutable)'}`);
  console.log(`Launches:           ${!gate ? 'open (no beta gate)' : gate.enabled ? 'invite-only (beta gate on)' : 'open (beta gate off)'}`);
  if (gate) console.log(`Beta admin:         ${gate.authority.toBase58()}`);
  try {
    const entries = await connection.getProgramAccounts(programId, { dataSlice: { offset: 8, length: 32 }, filters: [{ dataSize: 8 + 33 }, { memcmp: { offset: 0, bytes: base58(Uint8Array.from(DISCRIMINATORS.BetaCreator)) } }] });
    console.log(`Allowlisted:        ${entries.length}`);
    for (const { account } of entries) console.log(`  ${new web3.PublicKey(account.data).toBase58()}`);
  } catch { console.log('Allowlisted:        (this RPC does not allow listing; use a Helius RPC to list)'); }
} else if (command === 'allow' || command === 'revoke') {
  if (!targets.length) throw new Error(`Give at least one creator address: solana-beta.mjs ${command} <creator>`);
  const admin = signer();
  const gate = client.decodeBetaGate((await connection.getAccountInfo(client.betaGatePda))?.data);
  if (!gate) throw new Error('No beta gate exists. Create it with set-gate first.');
  if (!gate.authority.equals(admin.publicKey)) throw new Error(`This key (${admin.publicKey.toBase58()}) is not the beta admin (${gate.authority.toBase58()}). Pass --keypair <beta admin key>.`);
  for (const target of targets) {
    const creator = key(target);
    const exists = !!await connection.getAccountInfo(client.betaCreatorPda(creator));
    if (command === 'allow' && exists || command === 'revoke' && !exists) { console.log(`${creator.toBase58()}: already ${command === 'allow' ? 'allowed' : 'not on the list'}.`); continue; }
    await send(connection, admin, [command === 'allow' ? client.allowBetaCreator({ authority: admin.publicKey, creator }) : client.revokeBetaCreator({ authority: admin.publicKey, creator })]);
    console.log(`${creator.toBase58()}: ${command === 'allow' ? 'can now launch' : 'removed'}.`);
  }
} else if (command === 'set-gate') {
  if (!args.admin || !['true', 'false'].includes(args.enabled)) throw new Error('Use set-gate --admin <wallet> --enabled true|false');
  const authority = await upgradeAuthority();
  if (!authority) throw new Error('The program is immutable; the gate can no longer be changed.');
  const instruction = client.setBetaGate({ authority, gateAuthority: key(args.admin), enabled: args.enabled === 'true' });
  if (args.export) await exportFor(authority, instruction);
  else {
    const payer = signer();
    if (!payer.publicKey.equals(authority)) throw new Error(`The upgrade authority is ${authority.toBase58()}. If that is a multisig, run with --export and approve it there.`);
    await send(connection, payer, [instruction]);
    console.log(`Beta gate ${args.enabled === 'true' ? 'on (invite-only)' : 'off (open launches)'}; admin ${args.admin}.`);
  }
} else if (command === 'transfer-authority') {
  if (!args.to) throw new Error('Use transfer-authority --to <Squads vault address> --yes');
  const payer = signer(), current = await upgradeAuthority();
  if (!current?.equals(payer.publicKey)) throw new Error(`This key is not the upgrade authority (${current?.toBase58() ?? 'none'}).`);
  if (!args.yes) { console.log(`This hands control of program upgrades and configuration to ${args.to}. Double-check it is your Squads vault address (not the multisig account), then run again with --yes.`); process.exit(0); }
  await transferUpgradeAuthority({ connection, payer, programId, newAuthority: key(args.to) });
  console.log(`Upgrade authority is now ${args.to}.`);
} else if (command === 'prepare-upgrade') {
  if (!args.multisig) throw new Error('Use prepare-upgrade --multisig <Squads vault address>');
  const elfPath = `${root}contracts/solana/build/elpida_launchpad${cluster === 'mainnet' ? '-mainnet' : ''}.so`;
  const elf = readFileSync(elfPath);
  const payer = signer();
  await closeStaleBuffers({ connection, payer, elfLength: elf.length, onProgress: message => console.log(message) });
  const buffer = await prepareUpgradeBuffer({ connection, payer, elf, multisig: key(args.multisig), sendsPerSecond: Number(args.rate ?? (cluster === 'localnet' ? 100 : 3)), onProgress: message => console.log(message) });
  console.log(`\nBuffer ${buffer.toBase58()} holds ${elfPath} and belongs to ${args.multisig}.`);
  console.log(`In Squads: Programs → ${programId.toBase58()} → Upgrade, with buffer ${buffer.toBase58()} and spill address ${payer.publicKey.toBase58()}.`);
} else {
  console.log('Commands: status | allow <creator…> | revoke <creator…> | set-gate --admin <wallet> --enabled true|false [--export] | transfer-authority --to <vault> --yes | prepare-upgrade --multisig <vault>');
  process.exit(command ? 1 : 0);
}
