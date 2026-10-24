// Squads multisig rehearsal on Solana DEVNET (mainnet checklist C3). Before the mainnet program's upgrade authority
// moves to a Squads vault, this proves on devnet, on a throwaway copy of the program, that:
//   1. the upgrade authority can be handed to a 2-of-2 Squads vault, after which the deployer alone cannot upgrade;
//   2. an upgrade goes through only when both members approve, and Squads executes it;
//   3. the vault can hand authority back, and the throwaway program is then closed so its rent comes back.
// The live devnet program (ANkA5…) is never touched. Devnet only; it refuses any other cluster.
//
//   node scripts/squads-devnet-trial.mjs --keypair <deployer.json> [--rpc <devnet url>]
//
// It needs about 7.1 devnet SOL on the deployer at the peak (about 3.5 for the throwaway program, about 3.5 for the
// upgrade buffer, refunded by the upgrade); everything except fees comes back when the program is closed at the end.
// Each step is recorded in local-data/squads-trial/state.json, so an interrupted run resumes where it stopped.
// The second member key and the throwaway keys stay in local-data/squads-trial (git-ignored, devnet only).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

export const SQUADS_SDK = '@sqds/multisig@2.1.4';
export const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const LIVE_DEVNET_PROGRAM = 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz';
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * The upgrade and authority instructions the vault signs, built with the SDK's own web3.js (Squads compiles the
 * message with it). `loader` is loaderV3(web3) from packages/solana/client.mjs.
 */
export function vaultUpgrade({ loader, programId, programData, buffer, spill, vault }) {
  return [loader.upgrade({ programData, program: programId, buffer, spill, authority: vault })];
}
export function vaultHandBack({ loader, programData, vault, to }) {
  return [loader.setAuthority({ account: programData, authority: vault, newAuthority: to })];
}
/** Closing a program's data account needs the program account too (loader v3 Close with four accounts). */
export function closeProgram({ web3, programData, recipient, authority, programId }) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
    data: Buffer.from([5, 0, 0, 0]),
    keys: [{ pubkey: programData, isSigner: false, isWritable: true }, { pubkey: recipient, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }, { pubkey: programId, isSigner: false, isWritable: true }],
  });
}
/** Program data header: [u32 state=3][u64 last-deployed slot][option<authority>]. */
export function readProgramData(data) {
  const bytes = new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { slot: view.getBigUint64(4, true), authority: bytes[12] === 1 ? bytes.subarray(13, 45) : null };
}

/** Installs the Squads SDK into a temporary folder (not an app dependency) and returns it with its web3.js. */
function loadSquads() {
  const dir = join(tmpdir(), 'elpida-squads-sdk');
  const sdkPath = join(dir, 'node_modules/@sqds/multisig/package.json');
  if (!existsSync(sdkPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'elpida-squads-sdk', private: true }));
    console.log(`Installing ${SQUADS_SDK} into ${dir} (one time)…`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', SQUADS_SDK], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const require = createRequire(join(dir, 'package.json'));
  return { multisig: require('@sqds/multisig'), web3: require(require.resolve('@solana/web3.js', { paths: [join(dir, 'node_modules/@sqds/multisig')] })) };
}

async function main() {
  const { values: args } = parseArgs({ options: { keypair: { type: 'string' }, rpc: { type: 'string' }, yes: { type: 'boolean', default: false } } });
  if (!args.keypair) throw new Error('Pass --keypair <deployer.json> (the devnet deployer, for example ELPIDA\\elpida-v1\\local-data\\solana-deployer.json).');
  const rpcUrl = args.rpc ?? 'https://api.devnet.solana.com';
  const { multisig, web3 } = loadSquads();
  const { loaderV3, createElpidaSolana } = await import(pathToFileURL(join(root, 'packages/solana/client.mjs')).href);
  const { deployProgram } = await import(pathToFileURL(join(root, 'packages/solana/deploy.mjs')).href);
  const appWeb3 = await import('@solana/web3.js');
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('This rehearsal runs on Solana devnet only. Nothing was done.');
  if (!(await connection.getAccountInfo(new web3.PublicKey(SQUADS_PROGRAM)))?.executable) throw new Error('Squads v4 is not deployed on this cluster.');

  const dir = join(root, 'local-data/squads-trial'); mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json'), state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const keyFile = name => { const p = join(dir, name + '.json'); if (!existsSync(p)) writeFileSync(p, JSON.stringify([...web3.Keypair.generate().secretKey]), { mode: 0o600 }); return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')))); };
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(args.keypair, 'utf8'))));
  const member2 = keyFile('member2'), programKeypair = keyFile('program'), createKey = keyFile('create-key');
  if (programKeypair.publicKey.toBase58() === LIVE_DEVNET_PROGRAM) throw new Error('Refusing to use the live devnet program.');
  const loader = loaderV3(web3), programId = programKeypair.publicKey;
  const programData = createElpidaSolana(web3, programId).programDataAddress;
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const elf = readFileSync(join(root, 'contracts/solana/build/elpida_launchpad.so'));
  const sol = n => (Number(n) / 1e9).toFixed(3);
  const authorityOf = async () => { const info = await connection.getAccountInfo(programData); if (!info) return 'closed'; const a = readProgramData(info.data).authority; return a ? new web3.PublicKey(a).toBase58() : 'none'; };
  const slotOf = async () => readProgramData((await connection.getAccountInfo(programData)).data).slot;
  console.log(`Deployer:  ${payer.publicKey.toBase58()} (${sol(await connection.getBalance(payer.publicKey))} SOL)`);
  console.log(`Member 2:  ${member2.publicKey.toBase58()} (local key, devnet only)`);
  console.log(`Throwaway: ${programId.toBase58()}`);
  console.log(`Multisig:  ${multisigPda.toBase58()}  vault ${vault.toBase58()}`);

  // 1. Throwaway program, deployed exactly as the real one is.
  if (!state.deployed) {
    const rent = await connection.getMinimumBalanceForRentExemption(45 + elf.length);
    const need = BigInt(rent) * 2n + 100_000_000n;
    if (BigInt(await connection.getBalance(payer.publicKey)) < need) throw new Error(`The deployer needs about ${sol(need)} devnet SOL at the peak and has ${sol(await connection.getBalance(payer.publicKey))}. Top it up at faucet.solana.com (Devnet), then run again.`);
    const appConnection = new appWeb3.Connection(rpcUrl, 'confirmed'), appKey = k => appWeb3.Keypair.fromSecretKey(k.secretKey);
    await deployProgram({ connection: appConnection, payer: appKey(payer), programKeypair: appKey(programKeypair), elf, sendsPerSecond: 3, onProgress: m => console.log('  ' + m) });
    state.deployed = { slot: String(await slotOf()) }; save();
    console.log('1. Throwaway program deployed.');
  }
  // 2. A 2-of-2 Squads multisig: the deployer and member 2.
  if (!state.multisig) {
    const [configPda] = multisig.getProgramConfigPda({});
    const { treasury } = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, configPda);
    const all = multisig.types.Permissions.all();
    const signature = await multisig.rpc.multisigCreateV2({ connection, treasury, createKey, creator: payer, multisigPda, configAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
      members: [{ key: payer.publicKey, permissions: all }, { key: member2.publicKey, permissions: all }] });
    await connection.confirmTransaction(signature, 'confirmed');
    state.multisig = { address: multisigPda.toBase58(), vault: vault.toBase58(), signature }; save();
    console.log(`2. Multisig created (2 of 2): ${signature}`);
  }
  const vaultTx = async (label, instructions) => {
    const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const transactionIndex = BigInt(account.transactionIndex.toString()) + 1n;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new web3.TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions });
    const confirm = async s => { await connection.confirmTransaction(s, 'confirmed'); return s; };
    const create = await confirm(await multisig.rpc.vaultTransactionCreate({ connection, feePayer: payer, multisigPda, transactionIndex, creator: payer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo: label }));
    await confirm(await multisig.rpc.proposalCreate({ connection, feePayer: payer, multisigPda, transactionIndex, creator: payer }));
    await confirm(await multisig.rpc.proposalApprove({ connection, feePayer: payer, multisigPda, transactionIndex, member: payer }));
    return { transactionIndex, create, confirm };
  };
  const finish = async ({ transactionIndex, confirm }, needsSecond = true) => {
    if (needsSecond) await confirm(await multisig.rpc.proposalApprove({ connection, feePayer: payer, multisigPda, transactionIndex, member: member2 }));
    return confirm(await multisig.rpc.vaultTransactionExecute({ connection, feePayer: payer, multisigPda, transactionIndex, member: payer.publicKey }));
  };
  // 3. Hand the upgrade authority to the vault; the deployer alone can no longer upgrade.
  if (!state.handedOver) {
    await connection.confirmTransaction(await connection.sendTransaction(new web3.Transaction().add(loader.setAuthority({ account: programData, authority: payer.publicKey, newAuthority: vault })), [payer]), 'confirmed');
    if (await authorityOf() !== vault.toBase58()) throw new Error('The vault did not become the upgrade authority.');
    const attempt = await connection.simulateTransaction(new web3.Transaction({ feePayer: payer.publicKey, ...(await connection.getLatestBlockhash()) }).add(loader.setAuthority({ account: programData, authority: payer.publicKey, newAuthority: payer.publicKey })), [payer]);
    if (!attempt.value.err) throw new Error('The deployer could still change the authority alone.');
    state.handedOver = true; save();
    console.log('3. Upgrade authority is the vault; the deployer alone is refused.');
  }
  // 4. Upgrade through Squads: one approval is not enough; with both, Squads executes the upgrade.
  if (!state.upgraded) {
    const { prepareUpgradeBuffer } = await import(pathToFileURL(join(root, 'packages/solana/deploy.mjs')).href);
    const appConnection = new appWeb3.Connection(rpcUrl, 'confirmed');
    const buffer = state.buffer ?? (await prepareUpgradeBuffer({ connection: appConnection, payer: appWeb3.Keypair.fromSecretKey(payer.secretKey), elf, multisig: vault.toBase58(), sendsPerSecond: 3, onProgress: m => console.log('  ' + m) })).toBase58();
    state.buffer = buffer; save();
    const before = await slotOf();
    const proposal = await vaultTx('Elpida devnet rehearsal: upgrade', vaultUpgrade({ loader, programId, programData, buffer: new web3.PublicKey(buffer), spill: payer.publicKey, vault }));
    let early = null; try { await finish(proposal, false); } catch (error) { early = error; }
    if (!early) throw new Error('Squads executed with one approval of two.');
    const signature = await finish(proposal);
    const after = await slotOf();
    if (!(after > before)) throw new Error('The program was not upgraded.');
    state.upgraded = { signature, slotBefore: String(before), slotAfter: String(after) }; save();
    console.log(`4. Upgraded through Squads with 2 of 2 approvals (one was refused): ${signature}`);
  }
  // 5. Hand authority back, then close the throwaway program so its rent returns to the deployer.
  if (!state.handedBack) {
    const signature = await finish(await vaultTx('Elpida devnet rehearsal: hand back', vaultHandBack({ loader, programData, vault, to: payer.publicKey })));
    if (await authorityOf() !== payer.publicKey.toBase58()) throw new Error('Authority was not handed back.');
    state.handedBack = { signature }; save();
    console.log(`5. Authority handed back through Squads: ${signature}`);
  }
  if (!state.closed) {
    const before = await connection.getBalance(payer.publicKey);
    const signature = await connection.sendTransaction(new web3.Transaction().add(closeProgram({ web3, programData, recipient: payer.publicKey, authority: payer.publicKey, programId })), [payer]);
    await connection.confirmTransaction(signature, 'confirmed');
    state.closed = { signature, refunded: sol(await connection.getBalance(payer.publicKey) - before) }; save();
    console.log(`6. Throwaway program closed; ${state.closed.refunded} SOL back: ${signature}`);
  }
  console.log(`\nRehearsal complete. Send Claude ${statePath} (addresses and signatures only, no keys).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
