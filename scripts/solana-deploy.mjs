// Deploys and initializes the Elpida Solana program, then records it for the web app.
//
//   npm run solana:deploy                      # Solana Devnet with Circle devnet USDC
//   npm run solana:deploy -- --treasury <addr> # protocol fees to another wallet (default: deployer)
//   npm run solana:deploy -- --cluster localnet --fund <wallet>  # local solana-test-validator
//
// Mainnet beta (real SOL; see docs/MAINNET_BETA.md):
//   npm run solana:deploy -- --cluster mainnet --treasury <wallet or Squads vault> --sol-usd 150 \
//     [--beta-admin <wallet>] [--allow <creator> ...] [--transfer-authority <Squads vault>] --yes
// Mainnet uses build/elpida_launchpad-mainnet.so (no test instructions), real USDC and a SOL pair priced
// at $5k → $50k FDV from --sol-usd. Launches are open; --invite-only turns on the beta gate (allowlist).
//
// The deployer keypair is created at local-data/solana-deployer.json on first run (never share it).
// It pays rent (~5.8 SOL on devnet, mostly returned only if the program is closed) and becomes the
// program's upgrade authority. Get devnet SOL at https://faucet.solana.com.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { SOLANA_TEST_PAIRS, solanaMainnetPairs, MAINNET_USDC } from '../packages/core/pairs.mjs';
import { createElpidaSolana, curveParams, poolStats, DEFAULT_CURVE } from '../packages/solana/client.mjs';
import { deployProgram, upgradeProgram, upgradeCost, programStatus, initializeConfig, deploymentCost, createTestQuoteMint, airdrop, findExistingBuffer, closeStaleBuffers, ensureTestUsdc, ensurePairConfigs, ensureBetaGate, rejectsTestInstructions, transferUpgradeAuthority } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args } = parseArgs({ options: {
  cluster: { type: 'string', default: 'devnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  treasury: { type: 'string' }, 'quote-mint': { type: 'string' }, fund: { type: 'string', multiple: true, default: [] },
  rate: { type: 'string' }, // program-chunk uploads per second (public devnet allows only a few)
  upgrade: { type: 'boolean', default: false }, // upgrade an already deployed program to contracts/solana/build
  'start-fdv': { type: 'string' }, 'end-fdv': { type: 'string' }, // curve: starting and graduation FDV in USDC (default 5000 / 50000)
  'no-test-usdc': { type: 'boolean', default: false }, // skip the Elpida tUSDC faucet config on test networks
  'no-test-pairs': { type: 'boolean', default: false }, // skip the SOL, test xStock and test paired-token configs
  'sol-usd': { type: 'string' }, // mainnet: SOL price in USD used to price the SOL pair at $5k → $50k FDV
  'beta-admin': { type: 'string' }, // wallet that manages the beta allowlist (default: the deployer)
  allow: { type: 'string', multiple: true, default: [] }, // creators allowed to launch during the beta
  'invite-only': { type: 'boolean', default: false }, // turn on the beta gate: only allowlisted creators can launch
  'transfer-authority': { type: 'string' }, // hand the upgrade authority to this address (Squads vault) at the end
  yes: { type: 'boolean', default: false }, // required on mainnet: confirms spending real SOL
} });
if (!['devnet', 'localnet', 'mainnet'].includes(args.cluster)) throw new Error('--cluster must be devnet, localnet or mainnet');
const localnet = args.cluster === 'localnet';
const mainnet = args.cluster === 'mainnet';
const solUsd = Number(args['sol-usd']);
if (mainnet) {
  if (!args.treasury) throw new Error('Mainnet needs --treasury: the wallet or Squads vault that receives protocol fees.');
  if (!(solUsd > 0)) throw new Error('Mainnet needs --sol-usd <price> to price the SOL pair (for example --sol-usd 150).');
}
// A private devnet RPC (for example Helius) via --rpc or SOLANA_RPC_URL avoids public rate limits.
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (localnet ? 'http://127.0.0.1:8899' : mainnet ? 'https://api.mainnet-beta.solana.com' : solanaDevnet.rpcUrl);
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${localnet ? '-localnet' : mainnet ? '-mainnet' : ''}.json`;
// Two builds: the default one has the test faucet (devnet / localnet); the mainnet one rejects it.
const elfPath = `${root}contracts/solana/build/elpida_launchpad${mainnet ? '-mainnet' : ''}.so`;
const programKeyPath = `${root}contracts/solana/keys/elpida_launchpad-keypair.json`;
const outPath = `${root}local-data/solana-${args.cluster}.json`;
const sol = lamports => (Number(lamports) / web3.LAMPORTS_PER_SOL).toFixed(3);
const loadKeypair = path => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

mkdirSync(`${root}local-data`, { recursive: true });
if (!existsSync(keypairPath)) {
  writeFileSync(keypairPath, JSON.stringify([...web3.Keypair.generate().secretKey]), { mode: 0o600 });
  console.log(`Created a new deployer keypair at ${keypairPath} (keep it private).`);
}
for (const path of [elfPath, programKeyPath]) if (!existsSync(path)) throw new Error(`Missing ${path}. The compiled program and its keypair ship with this repository.`);
const payer = loadKeypair(keypairPath);
const programKeypair = loadKeypair(programKeyPath);
const elf = readFileSync(elfPath);
const connection = new web3.Connection(rpcUrl, 'confirmed');
const shownRpc = rpcUrl.replace(/([?&](api[-_]?key|key|token)=)[^&]+/i, '$1***');
console.log(`Cluster:   ${args.cluster} (${shownRpc})`);
console.log(`Deployer:  ${payer.publicKey.toBase58()}`);
console.log(`Program:   ${programKeypair.publicKey.toBase58()}`);
if (mainnet && !args.yes) {
  const need = await deploymentCost(connection, elf.length);
  console.log(`\nMainnet deployment spends real SOL: about ${sol(need)} SOL (program rent, most of it locked while the program exists, plus a temporary upload buffer).`);
  console.log('Treasury:  ' + args.treasury);
  console.log(`SOL pair:  priced at $${solUsd} per SOL. Launches: ${args['invite-only'] ? 'invite-only beta' : 'open to everyone'}.`);
  console.log('Run again with --yes to proceed.');
  process.exit(0);
}

const statePath = `${root}local-data/solana-${args.cluster}-deploy-state.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const deployed = (await connection.getAccountInfo(programKeypair.publicKey))?.executable;
// Buffers from an interrupted upload of an older build hold SOL; reclaim them first.
const reclaimed = await closeStaleBuffers({ connection, payer, elfLength: elf.length, remembered: [state.buffer], onProgress: message => console.log(message) });
if (reclaimed) console.log(`Reclaimed ${sol(reclaimed)} SOL from stale buffers.`);
if (!deployed) {
  const existingBuffer = await findExistingBuffer(connection, payer.publicKey, elf.length, state.buffer);
  const need = await deploymentCost(connection, elf.length, { reuseBuffer: !!existingBuffer });
  let balance = await connection.getBalance(payer.publicKey);
  if (balance < need && localnet) {
    await airdrop(connection, payer.publicKey, need - balance + web3.LAMPORTS_PER_SOL);
    balance = await connection.getBalance(payer.publicKey);
  }
  if (balance < need) {
    console.error(`\nThe deployer needs about ${sol(need)} SOL and has ${sol(balance)} SOL.`);
    console.error(mainnet ? `Send SOL to ${payer.publicKey.toBase58()}, then run this again.` : `Fund ${payer.publicKey.toBase58()} at https://faucet.solana.com (choose Devnet), then run this again.`);
    process.exit(1);
  }
  const result = await deployProgram({
    connection, payer, programKeypair, elf, rememberedBuffer: existingBuffer?.toBase58(),
    sendsPerSecond: Number(args.rate ?? (localnet ? 100 : 3)),
    onBuffer: buffer => writeFileSync(statePath, `${JSON.stringify({ ...state, buffer }, null, 2)}\n`),
    onProgress: message => console.log(message),
  });
  console.log(result.alreadyDeployed ? 'Program already deployed.' : 'Program deployed.');
} else {
  const status = await programStatus(connection, programKeypair.publicKey, elf);
  if (status.upToDate) console.log('Program already deployed and up to date.');
  else if (!args.upgrade) console.log('Program already deployed, but contracts/solana/build has a newer version. Run with --upgrade (solana-upgrade.cmd) to upgrade it.');
  else {
    const existingBuffer = await findExistingBuffer(connection, payer.publicKey, elf.length, state.buffer);
    const need = await upgradeCost(connection, programKeypair.publicKey, elf, { reuseBuffer: !!existingBuffer });
    let balance = await connection.getBalance(payer.publicKey);
    if (balance < need && localnet) { await airdrop(connection, payer.publicKey, need - balance + web3.LAMPORTS_PER_SOL); balance = await connection.getBalance(payer.publicKey); }
    if (balance < need) {
      console.error(`\nThe upgrade needs about ${sol(need)} SOL (mostly a temporary buffer, refunded after the upgrade) and the deployer has ${sol(balance)} SOL.`);
      console.error(mainnet ? `Send SOL to ${payer.publicKey.toBase58()}, then run this again.` : `Fund ${payer.publicKey.toBase58()} at https://faucet.solana.com (choose Devnet), then run this again.`);
      process.exit(1);
    }
    await upgradeProgram({
      connection, payer, programId: programKeypair.publicKey, elf, rememberedBuffer: existingBuffer?.toBase58(),
      sendsPerSecond: Number(args.rate ?? (localnet ? 100 : 3)),
      onBuffer: buffer => writeFileSync(statePath, `${JSON.stringify({ ...state, buffer }, null, 2)}\n`),
      onProgress: message => console.log(message),
    });
    console.log('Program upgraded.');
  }
}

let quoteMint = args['quote-mint'] ?? (localnet ? null : mainnet ? MAINNET_USDC : solanaDevnet.quote.address);
// The mainnet build must refuse test instructions; stop before any configuration if it does not.
if (mainnet && !await rejectsTestInstructions({ connection, payer, programId: programKeypair.publicKey })) {
  throw new Error('The deployed program accepts test instructions. Mainnet must use build/elpida_launchpad-mainnet.so. Do not continue: upgrade it with the mainnet build first.');
}
const client = createElpidaSolana(web3, programKeypair.publicKey);
const existingConfig = await connection.getAccountInfo(client.configPda);
if (existingConfig) quoteMint = client.decodeConfig(existingConfig.data).quoteMint.toBase58();
if (!quoteMint) {
  quoteMint = (await createTestQuoteMint({ connection, payer, recipients: [payer.publicKey.toBase58(), ...args.fund] })).toBase58();
  console.log(`Created local test USDC mint ${quoteMint}.`);
}
const startFdv = Number(args['start-fdv'] ?? DEFAULT_CURVE.startFdv);
const endFdv = Number(args['end-fdv'] ?? DEFAULT_CURVE.endFdv);
const quoteDecimals = (await connection.getAccountInfo(new web3.PublicKey(quoteMint)))?.data?.[44] ?? 6;
const { config, alreadyInitialized } = await initializeConfig({
  connection, payer, programId: programKeypair.publicKey, quoteMint, treasury: args.treasury ?? payer.publicKey.toBase58(),
  params: curveParams({ startFdv, endFdv, quoteDecimals }),
});
console.log(alreadyInitialized ? 'Curve config already initialized (parameters are fixed once set).' : `Curve config initialized: $${startFdv.toLocaleString()} starting FDV, graduation at $${endFdv.toLocaleString()} FDV.`);
// Test networks: a free-to-mint Elpida tUSDC with its own curve config, so curves can be completed and migrated.
let testUsdc = null;
if (!args['no-test-usdc'] && !mainnet) {
  testUsdc = await ensureTestUsdc({ connection, payer, programId: programKeypair.publicKey, treasury: config.treasury.toBase58(), params: curveParams({ startFdv, endFdv, quoteDecimals: 6 }) });
  console.log(testUsdc.created ? `Elpida tUSDC test config created (mint ${testUsdc.mint.toBase58()}).` : 'Elpida tUSDC test config already exists.');
}
// Test networks: SOL, a simulated xStock and a test paired token, each with its own curve config.
let pairs = [];
if (mainnet) {
  pairs = await ensurePairConfigs({ connection, payer, programId: programKeypair.publicKey, treasury: config.treasury.toBase58(), templates: solanaMainnetPairs(solUsd), onProgress: message => console.log(message) });
  for (const p of pairs) console.log(`${p.symbol} pair config ${p.created ? 'created' : 'already exists (parameters are fixed once set)'}.`);
} else if (!args['no-test-pairs']) {
  pairs = await ensurePairConfigs({ connection, payer, programId: programKeypair.publicKey, treasury: config.treasury.toBase58(), templates: SOLANA_TEST_PAIRS,
    saved: state.testAssets ?? {}, onProgress: message => console.log(message) });
  state.testAssets = Object.fromEntries(pairs.filter(p => p.test).map(p => [p.key, p.mint]));
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  for (const p of pairs) console.log(`${p.symbol} pair config ${p.created ? 'created' : 'already exists'} (${p.kind}, mint ${p.mint}).`);
}
// Beta launch gate: created on mainnet (off unless --invite-only), so it can be switched on later and the
// allowlist prepared in advance; on test networks only when asked for.
let betaGate = null;
if (mainnet || args['beta-admin'] || args['invite-only'] || args.allow.length) {
  betaGate = await ensureBetaGate({ connection, payer, programId: programKeypair.publicKey, gateAuthority: args['beta-admin'] ?? payer.publicKey.toBase58(), enabled: args['invite-only'], allow: args.allow, onProgress: message => console.log(message) });
  console.log(`Launches: ${betaGate.enabled ? 'invite-only (beta gate on)' : 'open to everyone'}; allowlist managed by ${betaGate.authority.toBase58()}.`);
}
const startStats = poolStats({ ...config, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 }, config.quoteDecimals);
const record = {
  cluster: args.cluster, rpcUrl: shownRpc, programId: programKeypair.publicKey.toBase58(), config: client.configPda.toBase58(),
  quoteMint: config.quoteMint.toBase58(), quoteDecimals: config.quoteDecimals, treasury: config.treasury.toBase58(),
  launchFee: config.launchFee.toString(), modelVersion: config.modelVersion,
  curve: {
    virtualQuote: config.virtualQuote.toString(), virtualToken: config.virtualToken.toString(), curveSupply: config.curveSupply.toString(),
    startFdv: Math.round(startStats.marketCap), baseFeeBps: config.baseFeeBps, snipeStartBps: config.snipeStartBps,
    snipeWindowSecs: config.snipeWindowSecs, maxCreatorBuyBps: config.maxCreatorBuyBps,
  },
  testUsdc: testUsdc ? { mint: testUsdc.mint.toBase58(), config: testUsdc.config.address.toBase58() } : null,
  // Every launchable pair: the default USDC config, tUSDC and the test-network pairs above.
  pairs: [
    { kind: 'usdc', key: 'usdc', symbol: 'USDC', name: localnet ? 'Local test USDC' : mainnet ? 'USDC' : 'Circle test USDC', mint: config.quoteMint.toBase58(), config: client.configPda.toBase58(), decimals: config.quoteDecimals, tokenProgram: (await connection.getAccountInfo(config.quoteMint)).owner.toBase58(), test: false },
    ...(testUsdc ? [{ kind: 'usdc', key: 'tusdc', symbol: 'tUSDC', name: 'Elpida tUSDC (free test USDC, no value)', mint: testUsdc.mint.toBase58(), config: testUsdc.config.address.toBase58(), decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', test: true, faucet: '25000' }] : []),
    ...pairs.map(({ created, ...p }) => p),
  ],
  deployer: payer.publicKey.toBase58(), recordedAt: new Date().toISOString(),
  build: mainnet ? 'mainnet' : 'testnet',
  betaGate: betaGate ? { enabled: betaGate.enabled, authority: betaGate.authority.toBase58() } : null,
};
// Last step: hand the upgrade authority to a multisig. After this, upgrades and config changes go
// through it (scripts/solana-beta.mjs prepares upgrade buffers and gate changes for Squads).
if (args['transfer-authority']) {
  await transferUpgradeAuthority({ connection, payer, programId: programKeypair.publicKey, newAuthority: args['transfer-authority'] });
  record.upgradeAuthority = args['transfer-authority'];
  console.log(`Upgrade authority transferred to ${args['transfer-authority']}.`);
} else record.upgradeAuthority = payer.publicKey.toBase58();
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(mainnet
  ? `\nSaved ${outPath}. To serve it: set ELPIDA_SOLANA_CLUSTER=mainnet and SOLANA_RPC_URL=<your Helius URL> in .env, restart, and pick Solana in the network menu.`
  : `\nSaved ${outPath}. Restart npm run dev and pick ${localnet ? 'Solana Localnet' : 'Solana Devnet'} in the network menu.`);
console.log(`To share this deployment with your team, copy programId into the shared field of solana-devnet in packages/core/networks.mjs.`);
