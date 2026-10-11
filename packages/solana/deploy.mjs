// Node-only helpers that deploy and initialize the Elpida Solana program over RPC.
// Used by scripts/solana-deploy.mjs and tests/solana.test.mjs.
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, loaderV3, splTestMint, curveParams, LOADER_V3, WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './client.mjs';

const { Keypair, PublicKey, Transaction, SystemProgram } = web3;
const CHUNK = 950;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Confirms by polling (no websocket, so scripts exit cleanly and public devnet limits are kinder). */
export async function confirmByPolling(connection, signature, lastValidBlockHeight) {
  for (let poll = 0; ; poll++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature]);
    if (status?.err) throw Object.assign(new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`), { signature });
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
    if (poll % 5 === 4 && await connection.getBlockHeight('confirmed') > lastValidBlockHeight) throw new Error(`Transaction ${signature} expired: block height exceeded`);
    await sleep(800);
  }
}

export async function send(connection, payer, instructions, signers = [], retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      tx.sign(payer, ...signers);
      const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
      return await confirmByPolling(connection, signature, lastValidBlockHeight);
    } catch (error) {
      const retryable = /blockhash|timed? ?out|429|ECONNRESET|fetch failed|block height exceeded/i.test(String(error.message));
      if (!retryable || attempt >= retries) throw error;
      await sleep(1500 * attempt);
    }
  }
}

/** Lamports still needed to deploy: program data + program account + fees, plus a new buffer unless one is reused. */
export async function deploymentCost(connection, elfLength, { reuseBuffer = false } = {}) {
  const loader = loaderV3(web3);
  const [programData, buffer, program] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(loader.PROGRAMDATA_HEADER + elfLength),
    connection.getMinimumBalanceForRentExemption(loader.BUFFER_HEADER + elfLength),
    connection.getMinimumBalanceForRentExemption(loader.PROGRAM_SIZE),
  ]);
  // Deploying drains the buffer into the payer before it funds the program data account.
  return (reuseBuffer ? program + Math.max(0, programData - buffer) : programData + buffer + program) + 20_000_000;
}

const isOurBuffer = (info, authority, size) => info && info.owner.toBase58() === LOADER_V3 && info.data.length === size
  && info.data[0] === 1 && info.data[4] === 1 && new PublicKey(info.data.subarray(5, 37)).equals(authority);

/**
 * Finds a buffer this deployer already created for this program size, so an interrupted upload resumes
 * instead of paying rent for a second buffer. Checks the remembered address first, then the deployer's
 * oldest recent transactions (the buffer is created right after funding).
 */
export async function findExistingBuffer(connection, authority, elfLength, remembered) {
  const loader = loaderV3(web3);
  const size = loader.BUFFER_HEADER + elfLength;
  if (remembered) {
    try { const key = new PublicKey(remembered); if (isOurBuffer(await connection.getAccountInfo(key), authority, size)) return key; } catch {}
  }
  const signatures = (await connection.getSignaturesForAddress(authority, { limit: 1000 }, 'confirmed')).filter(item => !item.err).reverse();
  for (const { signature } of signatures.slice(0, 8)) {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    for (const ix of tx?.transaction.message.instructions ?? []) {
      const info = ix.parsed?.info;
      if (ix.program === 'system' && ix.parsed?.type === 'createAccount' && info?.owner === LOADER_V3 && info.space === size) {
        const key = new PublicKey(info.newAccount);
        if (isOurBuffer(await connection.getAccountInfo(key), authority, size)) return key;
      }
    }
    await sleep(300);
  }
  return null;
}

/**
 * Uploads `elf` into a loader-v3 buffer owned by `payer`. Resumable: reuses an existing buffer of the
 * right size and only sends chunks whose bytes differ, at a throttled rate that fits public RPC limits.
 */
export async function uploadToBuffer({ connection, payer, elf, sendsPerSecond = 3, rememberedBuffer, onBuffer = () => {}, onProgress = () => {} }) {
  const loader = loaderV3(web3);
  const bufferSize = loader.BUFFER_HEADER + elf.length;
  let buffer = await findExistingBuffer(connection, payer.publicKey, elf.length, rememberedBuffer);
  if (buffer) onProgress(`Resuming with existing program buffer ${buffer.toBase58()}.`);
  else {
    const bufferKeypair = Keypair.generate();
    onProgress(`Creating a ${elf.length.toLocaleString()}-byte program buffer…`);
    await send(connection, payer, [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: bufferKeypair.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(bufferSize), space: bufferSize, programId: loader.loader }),
      loader.initializeBuffer(bufferKeypair.publicKey, payer.publicKey),
    ], [bufferKeypair]);
    buffer = bufferKeypair.publicKey;
  }
  onBuffer(buffer.toBase58());
  const total = Math.ceil(elf.length / CHUNK);
  for (let round = 1; ; round++) {
    const data = (await connection.getAccountInfo(buffer, 'confirmed')).data.subarray(loader.BUFFER_HEADER);
    const missing = [];
    for (let offset = 0; offset < elf.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, elf.length);
      if (!data.subarray(offset, end).equals(elf.subarray(offset, end))) missing.push(offset);
    }
    if (!missing.length) break;
    if (round > 6) throw new Error(`${missing.length} program chunks still failed to upload. Run the deploy again to resume.`);
    onProgress(`Uploading ${missing.length} of ${total} program chunks${round > 1 ? ` (retry round ${round})` : ''}…`);
    let latest = await connection.getLatestBlockhash('confirmed');
    let fetchedAt = Date.now();
    for (const [index, offset] of missing.entries()) {
      if (Date.now() - fetchedAt > 30_000) { latest = await connection.getLatestBlockhash('confirmed'); fetchedAt = Date.now(); }
      const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(loader.write(buffer, payer.publicKey, offset, elf.subarray(offset, offset + CHUNK)));
      tx.sign(payer);
      try { await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }); }
      catch (error) { if (!/429|fetch failed|ECONNRESET/i.test(String(error.message))) throw error; await sleep(3000); }
      if ((index + 1) % 50 === 0) onProgress(`  sent ${index + 1} of ${missing.length}…`);
      await sleep(1000 / sendsPerSecond);
    }
    onProgress('Waiting for the uploaded chunks to confirm…');
    await sleep(Math.min(20_000, 4000 + missing.length * 20));
  }
  onProgress('All program chunks uploaded.');
  return buffer;
}

const nextSlot = async connection => {
  const slot = await connection.getSlot('confirmed');
  while (await connection.getSlot('confirmed') <= slot) await sleep(400);
};

/** Deploys `elf` at `programKeypair` through the upgradeable loader. No-op when already deployed. */
export async function deployProgram({ connection, payer, programKeypair, elf, ...uploadOptions }) {
  const existing = await connection.getAccountInfo(programKeypair.publicKey);
  if (existing?.executable) return { programId: programKeypair.publicKey, alreadyDeployed: true };
  const loader = loaderV3(web3);
  const buffer = await uploadToBuffer({ connection, payer, elf, ...uploadOptions });
  uploadOptions.onProgress?.('Finalizing the deployment…');
  const client = createElpidaSolana(web3, programKeypair.publicKey);
  await send(connection, payer, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: programKeypair.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(loader.PROGRAM_SIZE), space: loader.PROGRAM_SIZE, programId: loader.loader }),
    loader.deploy({ payer: payer.publicKey, programData: client.programDataAddress, program: programKeypair.publicKey, buffer, authority: payer.publicKey, maxDataLen: elf.length }),
  ], [programKeypair]);
  await nextSlot(connection); // newly deployed programs become callable from the next slot
  return { programId: programKeypair.publicKey, alreadyDeployed: false };
}

/** Reads the deployed program data: upgrade authority and whether its bytes already equal `elf`. */
export async function programStatus(connection, programId, elf) {
  const client = createElpidaSolana(web3, programId);
  const info = await connection.getAccountInfo(client.programDataAddress, 'confirmed');
  if (!info) return { deployed: false };
  const loader = loaderV3(web3);
  const code = info.data.subarray(loader.PROGRAMDATA_HEADER);
  const authority = info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
  const upToDate = code.length >= elf.length && code.subarray(0, elf.length).equals(elf) && code.subarray(elf.length).every(byte => byte === 0);
  return { deployed: true, authority, capacity: code.length, upToDate };
}

/** Lamports needed to upgrade: a new buffer (unless reused) plus any program-data growth, plus fees. */
// Current clusters (devnet included) reject ExtendProgram below 10 KiB unless it reaches the 10 MiB maximum.
const MIN_EXTEND = 10_240;
const MAX_PROGRAM_DATA = 10 * 1024 * 1024;
export const extensionBytes = (needed, capacity) => (needed <= capacity ? 0 : Math.min(Math.max(needed - capacity, MIN_EXTEND), MAX_PROGRAM_DATA - capacity));

export async function upgradeCost(connection, programId, elf, { reuseBuffer = false } = {}) {
  const loader = loaderV3(web3);
  const status = await programStatus(connection, programId, elf);
  const grow = extensionBytes(elf.length, status.capacity ?? 0);
  const [buffer, before, after] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(loader.BUFFER_HEADER + elf.length),
    connection.getMinimumBalanceForRentExemption(loader.PROGRAMDATA_HEADER + (status.capacity ?? 0)),
    connection.getMinimumBalanceForRentExemption(loader.PROGRAMDATA_HEADER + (status.capacity ?? 0) + grow),
  ]);
  return (reuseBuffer ? 0 : buffer) + (after - before) + 20_000_000;
}

/**
 * Upgrades a deployed program in place (same program ID and accounts). Must be signed by the upgrade
 * authority. The buffer's rent is refunded to the payer by the upgrade.
 */
export async function upgradeProgram({ connection, payer, programId, elf, ...uploadOptions }) {
  const key = new PublicKey(programId);
  const status = await programStatus(connection, key, elf);
  if (!status.deployed) throw new Error('The program is not deployed yet. Deploy it first.');
  if (!status.authority?.equals(payer.publicKey)) throw new Error('This keypair is not the program upgrade authority.');
  if (status.upToDate) return { upgraded: false };
  const loader = loaderV3(web3);
  const client = createElpidaSolana(web3, key);
  const buffer = await uploadToBuffer({ connection, payer, elf, ...uploadOptions });
  if (elf.length > status.capacity) {
    const additionalBytes = extensionBytes(elf.length, status.capacity);
    uploadOptions.onProgress?.(`Extending program data by ${additionalBytes} bytes…`);
    const extend = { programData: client.programDataAddress, program: key, authority: payer.publicKey, payer: payer.publicKey, additionalBytes };
    try { await send(connection, payer, [loader.extendProgramChecked(extend)], [], 1); }
    catch (error) {
      // Clusters without the checked instruction reject it as invalid data; fall back to the legacy form.
      if (!/invalid instruction data/i.test(`${error.message} ${(error.transactionLogs ?? error.logs ?? []).join(' ')}`)) throw error;
      await send(connection, payer, [loader.extendProgram(extend)]);
    }
    await nextSlot(connection);
  }
  uploadOptions.onProgress?.('Upgrading the program…');
  await send(connection, payer, [loader.upgrade({ programData: client.programDataAddress, program: key, buffer, spill: payer.publicKey, authority: payer.publicKey })]);
  await nextSlot(connection);
  return { upgraded: true };
}

/**
 * Creates the program's curve config (quote mint, treasury, curve and fee parameters) when missing.
 * Must be signed by the upgrade authority. `params` defaults to `curveParams()` ($5k → $50k FDV).
 */
export async function initializeConfig({ connection, payer, programId, quoteMint, treasury, params }) {
  const client = createElpidaSolana(web3, programId);
  const existing = await connection.getAccountInfo(client.configPda);
  if (existing) return { config: client.decodeConfig(existing.data), alreadyInitialized: true };
  const mintInfo = await connection.getAccountInfo(new PublicKey(quoteMint));
  const quoteDecimals = mintInfo?.data?.[44] ?? 6;
  await send(connection, payer, [client.initializeCurve({ authority: payer.publicKey, quoteMint: new PublicKey(quoteMint), treasury: new PublicKey(treasury), params: params ?? curveParams({ quoteDecimals }) })]);
  return { config: client.decodeConfig((await connection.getAccountInfo(client.configPda)).data), alreadyInitialized: false };
}

/**
 * Closes this deployer's program buffers whose size no longer matches the build (left over from an
 * interrupted upload of an older version), returning their rent. Returns the lamports reclaimed.
 */
export async function closeStaleBuffers({ connection, payer, elfLength, remembered = [], onProgress = () => {} }) {
  const loader = loaderV3(web3);
  const wanted = loader.BUFFER_HEADER + elfLength;
  const candidates = new Set(remembered.filter(Boolean));
  try {
    const found = await connection.getProgramAccounts(loader.loader, {
      commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
      // Buffer variant (u32 1) with Some(authority) = payer. base58 '2' encodes the single byte 1.
      filters: [{ memcmp: { offset: 0, bytes: '2' } }, { memcmp: { offset: 4, bytes: '2' } }, { memcmp: { offset: 5, bytes: payer.publicKey.toBase58() } }],
    });
    for (const { pubkey } of found) candidates.add(pubkey.toBase58());
  } catch { /* some public RPCs refuse getProgramAccounts on the loader; fall back to remembered buffers */ }
  let reclaimed = 0;
  for (const address of candidates) {
    const key = new PublicKey(address);
    const info = await connection.getAccountInfo(key, 'confirmed');
    if (!info || info.owner.toBase58() !== LOADER_V3 || info.data[0] !== 1 || info.data[4] !== 1) continue;
    if (!new PublicKey(info.data.subarray(5, 37)).equals(payer.publicKey) || info.data.length === wanted) continue;
    onProgress(`Closing stale program buffer ${address} (reclaims ${(info.lamports / web3.LAMPORTS_PER_SOL).toFixed(3)} SOL)…`);
    await send(connection, payer, [loader.close({ account: key, recipient: payer.publicKey, authority: payer.publicKey })]);
    reclaimed += info.lamports;
  }
  return reclaimed;
}

/**
 * Test networks only: creates the program's Elpida tUSDC mint (PDA, minted only by the program's
 * faucet) and a curve config quoted in it, so anyone can get enough test USDC to complete a curve.
 */
export async function ensureTestUsdc({ connection, payer, programId, treasury, params }) {
  const client = createElpidaSolana(web3, programId);
  const mint = client.testUsdcMint, configAddress = client.configFor(mint);
  if (!await connection.getAccountInfo(mint)) await send(connection, payer, [client.createTestUsdc({ authority: payer.publicKey })]);
  let created = false;
  if (!await connection.getAccountInfo(configAddress)) {
    await send(connection, payer, [client.addCurveConfig({ authority: payer.publicKey, quoteMint: mint, treasury: new PublicKey(treasury), params: params ?? curveParams() })]);
    created = true;
  }
  return { mint, config: { address: configAddress, ...client.decodeConfig((await connection.getAccountInfo(configAddress)).data) }, created };
}

/**
 * Test networks only: one curve config per pair template (packages/core/pairs.mjs SOLANA_TEST_PAIRS).
 * Native SOL uses the wrapped-SOL mint. Test assets are new mints whose only minter is the program's
 * faucet PDA; the simulated xStock is a Token-2022 mint with an issuer permanent delegate, like xStocks.
 * `saved` maps template keys to mints from an earlier run so re-runs reuse them. Returns pair records.
 */
export async function ensurePairConfigs({ connection, payer, programId, treasury, templates, saved = {}, overrides = {}, onProgress = () => {} }) {
  const client = createElpidaSolana(web3, programId);
  const spl = splTestMint(web3);
  const pairs = [];
  for (const t of templates) {
    let mint = t.wsol ? new PublicKey(WSOL_MINT) : saved[t.key] ? new PublicKey(saved[t.key]) : null;
    if (mint && !t.wsol && !await connection.getAccountInfo(mint)) mint = null;
    if (!mint) {
      const kp = Keypair.generate();
      onProgress(`Creating ${t.symbol} test mint ${kp.publicKey.toBase58()}…`);
      const ixs = t.token2022
        ? await spl.createMint2022Ixs(connection, payer.publicKey, kp.publicKey, t.decimals, client.faucetAuthority, t.permanentDelegate === false ? null : payer.publicKey)
        : await spl.createMintIxs(connection, payer.publicKey, kp.publicKey, t.decimals, client.faucetAuthority);
      await send(connection, payer, ixs, [kp]);
      mint = kp.publicKey;
    }
    const info = await connection.getAccountInfo(mint);
    const quoteTokenProgram = info.owner;
    const address = client.configFor(mint);
    let created = false;
    if (!await connection.getAccountInfo(address)) {
      onProgress(`Creating the ${t.symbol} pair config…`);
      await send(connection, payer, [client.addCurveConfig({ authority: payer.publicKey, quoteMint: mint, treasury: new PublicKey(treasury), quoteTokenProgram,
        params: curveParams({ startFdv: t.startFdv, endFdv: t.endFdv, quoteDecimals: t.decimals, launchFee: t.launchFee, ...overrides }) })]);
      created = true;
    }
    pairs.push({ kind: t.kind, key: t.key, symbol: t.symbol, name: t.name, mint: mint.toBase58(), config: address.toBase58(), decimals: t.decimals,
      tokenProgram: quoteTokenProgram.toBase58(), test: !t.wsol, wsol: !!t.wsol, testSized: !!t.testSized, faucet: t.faucet ?? null, created });
  }
  return pairs;
}

/**
 * Creates or updates the beta launch gate (upgrade authority), then allowlists `allow` creators when the
 * payer is also the gate authority. Returns the gate state.
 */
export async function ensureBetaGate({ connection, payer, programId, gateAuthority, enabled, allow = [], onProgress = () => {} }) {
  const client = createElpidaSolana(web3, programId);
  const current = client.decodeBetaGate((await connection.getAccountInfo(client.betaGatePda))?.data);
  const authority = new PublicKey(gateAuthority);
  if (!current || !current.authority.equals(authority) || current.enabled !== enabled) {
    onProgress(`${current ? 'Updating' : 'Creating'} the beta launch gate (${enabled ? 'invite-only' : 'open'}, managed by ${authority.toBase58()})…`);
    await send(connection, payer, [client.setBetaGate({ authority: payer.publicKey, gateAuthority: authority, enabled })]);
  }
  for (const creator of allow) {
    if (!authority.equals(payer.publicKey)) throw new Error('Only the beta admin key can allowlist creators. Use scripts/solana-beta.mjs with that key.');
    if (await connection.getAccountInfo(client.betaCreatorPda(creator))) continue;
    onProgress(`Allowlisting creator ${creator}…`);
    await send(connection, payer, [client.allowBetaCreator({ authority: payer.publicKey, creator: new PublicKey(creator) })]);
  }
  return client.decodeBetaGate((await connection.getAccountInfo(client.betaGatePda)).data);
}

/**
 * True when the deployed program refuses test-only instructions (the mainnet build). Simulates the
 * stateless test_build_check instruction: the mainnet build fails with TestNetworksOnly (6022).
 */
export async function rejectsTestInstructions({ connection, payer, programId }) {
  const client = createElpidaSolana(web3, programId);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(client.testBuildCheck());
  tx.sign(payer);
  const result = await connection.simulateTransaction(tx);
  return JSON.stringify(result.value.err ?? '').includes('6022') || (result.value.logs ?? []).some(line => /TestNetworksOnly|0x1786/.test(line));
}

/** Hands the program's upgrade authority to `newAuthority` (for example a Squads vault). */
export async function transferUpgradeAuthority({ connection, payer, programId, newAuthority }) {
  const loader = loaderV3(web3);
  const client = createElpidaSolana(web3, programId);
  return send(connection, payer, [loader.setAuthority({ account: client.programDataAddress, authority: payer.publicKey, newAuthority: new PublicKey(newAuthority) })]);
}

/**
 * Upgrades under a multisig: uploads the build to a buffer, then hands the buffer to the multisig so it
 * can approve the upgrade (Squads: Programs → Upgrade, with this buffer). Returns the buffer address.
 */
export async function prepareUpgradeBuffer({ connection, payer, elf, multisig, ...uploadOptions }) {
  const loader = loaderV3(web3);
  const buffer = await uploadToBuffer({ connection, payer, elf, ...uploadOptions });
  await send(connection, payer, [loader.setAuthority({ account: buffer, authority: payer.publicKey, newAuthority: new PublicKey(multisig) })]);
  return buffer;
}

/** Localnet only: a 6-decimal stand-in for USDC, with balances minted to `recipients`. */
export async function createTestQuoteMint({ connection, payer, recipients = [], amount = 10_000_000_000n }) {
  const mint = Keypair.generate();
  const spl = splTestMint(web3);
  await send(connection, payer, await spl.createMintIxs(connection, payer.publicKey, mint.publicKey, 6, payer.publicKey), [mint]);
  const client = createElpidaSolana(web3, PublicKey.default);
  for (const owner of recipients) {
    const key = new PublicKey(owner);
    await send(connection, payer, [client.createAtaIdempotent(payer.publicKey, key, mint.publicKey), spl.mintTo(mint.publicKey, client.ata(key, mint.publicKey), payer.publicKey, amount)]);
  }
  return mint.publicKey;
}

/** Airdrop (localnet/devnet faucet) confirmed by polling. */
export async function airdrop(connection, address, lamports) {
  const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  return confirmByPolling(connection, await connection.requestAirdrop(new PublicKey(address), Number(lamports)), lastValidBlockHeight + 150);
}
