// Deploys and initializes the Elpida Solana program, then records it for the web app.
//
//   npm run solana:deploy                      # Solana Devnet with Circle devnet USDC
//   npm run solana:deploy -- --treasury <addr> # protocol fees to another wallet (default: deployer)
//   npm run solana:deploy -- --cluster localnet --fund <wallet>  # local solana-test-validator
//
// The deployer keypair is created at local-data/solana-deployer.json on first run (never share it).
// It pays rent (~5.8 SOL on devnet, mostly returned only if the program is closed) and becomes the
// program's upgrade authority. Get devnet SOL at https://faucet.solana.com.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { SOLANA_TEST_PAIRS } from '../packages/core/pairs.mjs';
import { createElpidaSolana, curveParams, poolStats, DEFAULT_CURVE } from '../packages/solana/client.mjs';
import { deployProgram, upgradeProgram, upgradeCost, programStatus, initializeConfig, deploymentCost, createTestQuoteMint, airdrop, findExistingBuffer, closeStaleBuffers, ensureTestUsdc, ensurePairConfigs } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args } = parseArgs({ options: {
  cluster: { type: 'string', default: 'devnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  treasury: { type: 'string' }, 'quote-mint': { type: 'string' }, fund: { type: 'string', multiple: true, default: [] },
  rate: { type: 'string' }, // program-chunk uploads per second (public devnet allows only a few)
  upgrade: { type: 'boolean', default: false }, // upgrade an already deployed program to contracts/solana/build
  'start-fdv': { type: 'string' }, 'end-fdv': { type: 'string' }, // curve: starting and graduation FDV in USDC (default 5000 / 50000)
  'no-test-usdc': { type: 'boolean', default: false }, // skip the Elpida tUSDC faucet config on test networks
  'no-test-pairs': { type: 'boolean', default: false }, // skip the SOL, test xStock and test paired-token configs
} });
if (!['devnet', 'localnet'].includes(args.cluster)) throw new Error('--cluster must be devnet or localnet');
const localnet = args.cluster === 'localnet';
// A private devnet RPC (for example Helius) via --rpc or SOLANA_RPC_URL avoids public rate limits.
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (localnet ? 'http://127.0.0.1:8899' : solanaDevnet.rpcUrl);
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${localnet ? '-localnet' : ''}.json`;
const elfPath = `${root}contracts/solana/build/elpida_launchpad.so`;
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
    console.error(`Fund ${payer.publicKey.toBase58()} at https://faucet.solana.com (choose Devnet), then run this again.`);
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
      console.error(`Fund ${payer.publicKey.toBase58()} at https://faucet.solana.com (choose Devnet), then run this again.`);
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

let quoteMint = args['quote-mint'] ?? (localnet ? null : solanaDevnet.quote.address);
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
if (!args['no-test-usdc']) {
  testUsdc = await ensureTestUsdc({ connection, payer, programId: programKeypair.publicKey, treasury: config.treasury.toBase58(), params: curveParams({ startFdv, endFdv, quoteDecimals: 6 }) });
  console.log(testUsdc.created ? `Elpida tUSDC test config created (mint ${testUsdc.mint.toBase58()}).` : 'Elpida tUSDC test config already exists.');
}
// Test networks: SOL, a simulated xStock and a test paired token, each with its own curve config.
let pairs = [];
if (!args['no-test-pairs']) {
  pairs = await ensurePairConfigs({ connection, payer, programId: programKeypair.publicKey, treasury: config.treasury.toBase58(), templates: SOLANA_TEST_PAIRS,
    saved: state.testAssets ?? {}, onProgress: message => console.log(message) });
  state.testAssets = Object.fromEntries(pairs.filter(p => p.test).map(p => [p.key, p.mint]));
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  for (const p of pairs) console.log(`${p.symbol} pair config ${p.created ? 'created' : 'already exists'} (${p.kind}, mint ${p.mint}).`);
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
    { kind: 'usdc', key: 'usdc', symbol: 'USDC', name: localnet ? 'Local test USDC' : 'Circle test USDC', mint: config.quoteMint.toBase58(), config: client.configPda.toBase58(), decimals: config.quoteDecimals, tokenProgram: (await connection.getAccountInfo(config.quoteMint)).owner.toBase58(), test: false },
    ...(testUsdc ? [{ kind: 'usdc', key: 'tusdc', symbol: 'tUSDC', name: 'Elpida tUSDC (free test USDC, no value)', mint: testUsdc.mint.toBase58(), config: testUsdc.config.address.toBase58(), decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', test: true, faucet: '25000' }] : []),
    ...pairs.map(({ created, ...p }) => p),
  ],
  deployer: payer.publicKey.toBase58(), recordedAt: new Date().toISOString(),
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\nSaved ${outPath}. Restart npm run dev and pick ${localnet ? 'Solana Localnet' : 'Solana Devnet'} in the network menu.`);
console.log(`To share this deployment with your team, copy programId into the shared field of solana-devnet in packages/core/networks.mjs.`);
