// Deploys and initializes the Elpida Solana program, then records it for the web app.
//
//   npm run solana:deploy                      # Solana Devnet
//   npm run solana:deploy -- --treasury <addr> # protocol fees to another wallet (default: deployer)
//   npm run solana:deploy -- --cluster localnet  # local solana-test-validator
//
// Mainnet beta (real SOL; see docs/MAINNET_BETA.md):
//   npm run solana:deploy -- --cluster mainnet --treasury <wallet or Squads vault> \
//     [--beta-admin <wallet>] [--allow <creator> ...] [--transfer-authority <Squads vault>] --yes
// Mainnet uses build/elpida_launchpad-mainnet.so (no test instructions). Launches are open; --invite-only
// turns on the beta gate (allowlist).
//
// Pricing is native: the SOL pair's curve and the SOL creation fee come from config/native-pricing.json
// (solana.<cluster>). Each run creates the SOL pair config or reprices it to the file's values for
// future launches. To only reprice, use node scripts/native-pricing.mjs.
//
// The deployer keypair is created at local-data/solana-deployer.json on first run (never share it).
// It pays rent (~5.8 SOL on devnet, mostly returned only if the program is closed) and becomes the
// program's upgrade authority. Get devnet SOL at https://faucet.solana.com.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { solanaPairTemplates } from '../packages/core/pairs.mjs';
import { solanaPricing } from '../packages/core/pricing.mjs';
import { SOLANA_ORACLES } from '../packages/core/usd-oracles.mjs';
import { createElpidaSolana, poolStats } from '../packages/solana/client.mjs';
import { declaredProgramId } from '../packages/solana/program-id.mjs';
import { savedTestAssets } from '../packages/solana/deploy-record.mjs';
import { deployProgram, upgradeProgram, upgradeCost, programStatus, deploymentCost, airdrop, findExistingBuffer, closeStaleBuffers, ensurePairConfigs, ensureBetaGate, rejectsTestInstructions, transferUpgradeAuthority, upgradeAuthority, ensurePricing } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args } = parseArgs({ options: {
  cluster: { type: 'string', default: 'devnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  treasury: { type: 'string' },
  rate: { type: 'string' }, // program-chunk uploads per second (public devnet allows only a few)
  upgrade: { type: 'boolean', default: false }, // upgrade an already deployed program to contracts/solana/build
  'no-test-pairs': { type: 'boolean', default: false }, // test networks: skip the test paired-token config
  'stock-pairs': { type: 'boolean', default: false }, // test networks: add the tTSLAon stand-in (needs the locked-pool program)
  'beta-admin': { type: 'string' }, // wallet that manages the beta allowlist (default: the deployer)
  allow: { type: 'string', multiple: true, default: [] }, // creators allowed to launch during the beta
  'invite-only': { type: 'boolean', default: false }, // turn on the beta gate: only allowlisted creators can launch
  'transfer-authority': { type: 'string' }, // hand the upgrade authority to this address (Squads vault) at the end
  yes: { type: 'boolean', default: false }, // required on mainnet: confirms spending real SOL
} });
if (!['devnet', 'localnet', 'mainnet'].includes(args.cluster)) throw new Error('--cluster must be devnet, localnet or mainnet');
const localnet = args.cluster === 'localnet';
const mainnet = args.cluster === 'mainnet';
const pricing = solanaPricing(args.cluster);
if (mainnet && !args.treasury) throw new Error('Mainnet needs --treasury: the wallet or Squads vault that receives protocol fees.');
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
if (!existsSync(elfPath)) throw new Error(`Missing ${elfPath}. The compiled program ships with this repository; run git pull.`);
// An upgrade must be signed by the program's upgrade authority, the deployer that first deployed it. A new keypair
// could never upgrade it, so --upgrade never creates one.
if (!existsSync(keypairPath)) {
  if (args.upgrade) throw new Error(`No deployer keypair at ${keypairPath}. An upgrade must be signed by the program's upgrade authority: the deployer that first deployed it. Copy local-data/solana-deployer.json from the folder you deployed from (for example elpida-v1) into this folder's local-data, or pass --keypair <path>. Never share that file.`);
  writeFileSync(keypairPath, JSON.stringify([...web3.Keypair.generate().secretKey]), { mode: 0o600 });
  console.log(`Created a new deployer keypair at ${keypairPath} (keep it private).`);
}
const payer = loadKeypair(keypairPath);
// The program keypair (contracts/solana/keys, never committed) is needed only to deploy a new program. An upgrade
// needs only the program's address, which is the one declared in the program source.
const programKeypair = existsSync(programKeyPath) ? loadKeypair(programKeyPath) : null;
const programId = programKeypair?.publicKey ?? new web3.PublicKey(declaredProgramId(readFileSync(`${root}contracts/solana/programs/elpida_launchpad/src/lib.rs`, 'utf8')));
const elf = readFileSync(elfPath);
const connection = new web3.Connection(rpcUrl, 'confirmed');
const shownRpc = rpcUrl.replace(/([?&](api[-_]?key|key|token)=)[^&]+/i, '$1***');
console.log(`Cluster:   ${args.cluster} (${shownRpc})`);
console.log(`Deployer:  ${payer.publicKey.toBase58()}`);
console.log(`Program:   ${programId.toBase58()}`);
if (mainnet && !args.yes) {
  const need = await deploymentCost(connection, elf.length);
  console.log(`\nMainnet deployment spends real SOL: about ${sol(need)} SOL (program rent, most of it locked while the program exists, plus a temporary upload buffer).`);
  console.log('Treasury:  ' + args.treasury);
  console.log(`Pricing:   ${pricing.launchFee} SOL creation fee, ${pricing.startFdv} → ${pricing.endFdv} SOL FDV (config/native-pricing.json).`);
  console.log(`Launches:  ${args['invite-only'] ? 'invite-only beta' : 'open to everyone'}.`);
  console.log('Run again with --yes to proceed.');
  process.exit(0);
}

const statePath = `${root}local-data/solana-${args.cluster}-deploy-state.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const deployed = (await connection.getAccountInfo(programId))?.executable;
if (!deployed && !programKeypair) throw new Error(`Missing ${programKeyPath}. Deploying a new program needs its keypair; copy contracts/solana/keys from the folder it was created in (for example elpida-v1). Never share it.`);
// Check the authority before uploading anything, so a wrong keypair spends no SOL.
if (deployed && args.upgrade) {
  const authority = await upgradeAuthority(connection, programId);
  if (authority && !authority.equals(payer.publicKey)) {
    console.error(`\nThis deployer (${payer.publicKey.toBase58()}) is not the program's upgrade authority (${authority.toBase58()}). Nothing was uploaded.`);
    console.error(`Use the original deployer keypair: copy local-data/solana-deployer.json from the folder you first deployed from (for example elpida-v1) over ${keypairPath}, or pass --keypair <path>.`);
    process.exit(1);
  }
}
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
  const status = await programStatus(connection, programId, elf);
  if (status.upToDate) console.log('Program already deployed and up to date.');
  else if (!args.upgrade) console.log('Program already deployed, but contracts/solana/build has a newer version. Run with --upgrade (solana-upgrade.cmd) to upgrade it.');
  else {
    const existingBuffer = await findExistingBuffer(connection, payer.publicKey, elf.length, state.buffer);
    const need = await upgradeCost(connection, programId, elf, { reuseBuffer: !!existingBuffer });
    let balance = await connection.getBalance(payer.publicKey);
    if (balance < need && localnet) { await airdrop(connection, payer.publicKey, need - balance + web3.LAMPORTS_PER_SOL); balance = await connection.getBalance(payer.publicKey); }
    if (balance < need) {
      console.error(`\nThe upgrade needs about ${sol(need)} SOL (mostly a temporary buffer, refunded after the upgrade) and the deployer has ${sol(balance)} SOL.`);
      console.error(mainnet ? `Send SOL to ${payer.publicKey.toBase58()}, then run this again.` : `Fund ${payer.publicKey.toBase58()} at https://faucet.solana.com (choose Devnet), then run this again.`);
      process.exit(1);
    }
    await upgradeProgram({
      connection, payer, programId: programId, elf, rememberedBuffer: existingBuffer?.toBase58(),
      sendsPerSecond: Number(args.rate ?? (localnet ? 100 : 3)),
      onBuffer: buffer => writeFileSync(statePath, `${JSON.stringify({ ...state, buffer }, null, 2)}\n`),
      onProgress: message => console.log(message),
    });
    console.log('Program upgraded.');
  }
}

// The mainnet build must refuse test instructions; stop before any configuration if it does not.
if (mainnet && !await rejectsTestInstructions({ connection, payer, programId: programId })) {
  throw new Error('The deployed program accepts test instructions. Mainnet must use build/elpida_launchpad-mainnet.so. Do not continue: upgrade it with the mainnet build first.');
}
const client = createElpidaSolana(web3, programId);
// Repricing needs the upgrade authority; once it is a multisig, use scripts/native-pricing.mjs --export.
const isAuthority = (await upgradeAuthority(connection, programId))?.equals(payer.publicKey) ?? false;
if (!isAuthority) console.log('The upgrade authority is not this deployer (multisig?): existing pair configs are left as they are. Reprice with node scripts/native-pricing.mjs --export.');
// Native SOL pair (and, on test networks, a test paired token), created or repriced to config/native-pricing.json.
const publishedPath = `${root}deployments/solana-${args.cluster}.json`;
const published = !localnet && existsSync(publishedPath) ? JSON.parse(readFileSync(publishedPath, 'utf8')) : null;
const pairs = await ensurePairConfigs({ connection, payer, programId: programId, treasury: args.treasury ?? payer.publicKey.toBase58(),
  templates: solanaPairTemplates(pricing, { test: !mainnet && !args['no-test-pairs'], usdcMint: SOLANA_ORACLES[args.cluster]?.usdcMint, usdcStartFdv: mainnet?'5000':'50', stocks: !mainnet && !!args['stock-pairs'] }), saved: savedTestAssets(state, published, programId.toBase58()), reprice: isAuthority, onProgress: message => console.log(message) });
state.testAssets = Object.fromEntries(pairs.filter(p => p.test).map(p => [p.key, p.mint]));
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
for (const p of pairs) console.log(`${p.symbol} pair config ${p.created ? 'created' : p.repriced ? 'repriced for future launches' : 'up to date'} (${p.kind}, mint ${p.mint}).`);
const native = pairs.find(p => p.kind === 'native');
// USD pricing on the SOL pair: the $10 fee (SOL or USDC) and the starting FDV come from the verified Pyth
// SOL/USD account at each launch. Without it the fixed SOL fee from config/native-pricing.json applies.
let usdPricing = null;
const oracle = SOLANA_ORACLES[args.cluster];
if (oracle && isAuthority) {
  try {
    const result = await ensurePricing({ connection, payer, programId: programId, config: native.config, oracle, onProgress: message => console.log(message) });
    // Other pairs (for example TEST-MEME) pay the same $10 fee; their curves stay sized in the pair asset.
    for (const pair of pairs.filter(p => p.kind !== 'native')) await ensurePricing({ connection, payer, programId: programId, config: pair.config, oracle: { ...oracle, startFdvUsdE6: '0' }, onProgress: message => console.log(`${pair.symbol}: ${message}`) });
    usdPricing = { enabled: true, priceAccount: oracle.priceAccount, feedId: oracle.feedId, maxAgeSecs: oracle.maxAgeSecs, maxConfBps: oracle.maxConfBps, feeUsdE6: oracle.feeUsdE6, startFdvUsdE6: oracle.startFdvUsdE6, usdcMint: oracle.usdcMint };
    console.log(`USD pricing ${result.created ? 'turned on' : result.updated ? 'updated' : 'already on'}: SOL/USD ${(Number(result.price.price) * 10 ** result.price.exponent).toFixed(2)} (published ${new Date(result.price.publishTime * 1000).toISOString()}).`);
  } catch (error) {
    console.log(`USD pricing not turned on: ${error.message} Launches keep the fixed SOL fee until it is.`);
  }
}
const config = { address: native.config, ...client.decodeConfig((await connection.getAccountInfo(new web3.PublicKey(native.config))).data) };
// Beta launch gate: created on mainnet (off unless --invite-only), so it can be switched on later and the
// allowlist prepared in advance; on test networks only when asked for.
let betaGate = null;
if (mainnet || args['beta-admin'] || args['invite-only'] || args.allow.length) {
  betaGate = await ensureBetaGate({ connection, payer, programId: programId, gateAuthority: args['beta-admin'] ?? payer.publicKey.toBase58(), enabled: args['invite-only'], allow: args.allow, onProgress: message => console.log(message) });
  console.log(`Launches: ${betaGate.enabled ? 'invite-only (beta gate on)' : 'open to everyone'}; allowlist managed by ${betaGate.authority.toBase58()}.`);
}
const startStats = poolStats({ ...config, realQuote: 0n, sold: 0n, liquidityBonus: 0n, status: 0 }, config.quoteDecimals);
const record = {
  cluster: args.cluster, rpcUrl: shownRpc, programId: programId.toBase58(), config: config.address,
  quoteMint: config.quoteMint.toBase58(), quoteDecimals: config.quoteDecimals, treasury: config.treasury.toBase58(),
  // Native pricing: the creation fee in lamports (SOL) and FDVs in SOL, from config/native-pricing.json.
  launchFee: config.launchFee.toString(), launchFeeSol: pricing.launchFee, modelVersion: config.modelVersion,
  curve: {
    virtualQuote: config.virtualQuote.toString(), virtualToken: config.virtualToken.toString(), curveSupply: config.curveSupply.toString(),
    startFdv: Number(startStats.marketCap.toFixed(4)), endFdv: Number(pricing.endFdv), baseFeeBps: config.baseFeeBps, snipeStartBps: config.snipeStartBps,
    snipeWindowSecs: config.snipeWindowSecs, maxCreatorBuyBps: config.maxCreatorBuyBps,
  },
  // Every launchable pair: native SOL and, on test networks, the test paired token.
  pairs: pairs.map(({ created, repriced, ...p }) => p),
  usdPricing,
  deployer: payer.publicKey.toBase58(), recordedAt: new Date().toISOString(),
  build: mainnet ? 'mainnet' : 'testnet',
  betaGate: betaGate ? { enabled: betaGate.enabled, authority: betaGate.authority.toBase58() } : null,
};
// Last step: hand the upgrade authority to a multisig. After this, upgrades and config changes go
// through it (scripts/solana-beta.mjs prepares upgrade buffers and gate changes for Squads).
if (args['transfer-authority']) {
  await transferUpgradeAuthority({ connection, payer, programId: programId, newAuthority: args['transfer-authority'] });
  record.upgradeAuthority = args['transfer-authority'];
  console.log(`Upgrade authority transferred to ${args['transfer-authority']}.`);
} else record.upgradeAuthority = payer.publicKey.toBase58();
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
// Public copy for hosted servers (Railway never sees local-data). Addresses and parameters only, no keys:
// commit and push it so the hosted site finds this deployment.
if (!localnet) {
  mkdirSync(`${root}deployments`, { recursive: true });
  writeFileSync(`${root}deployments/solana-${args.cluster}.json`, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote deployments/solana-${args.cluster}.json. Commit and push it so the hosted site (Railway) uses this deployment.`);
}
console.log(mainnet
  ? `\nSaved ${outPath}. To serve it: set ELPIDA_SOLANA_CLUSTER=mainnet and SOLANA_RPC_URL=<your Helius URL> in .env, restart, and pick Solana in the network menu.`
  : `\nSaved ${outPath}. Restart npm run dev and pick ${localnet ? 'Solana Localnet' : 'Solana Devnet'} in the network menu.`);
console.log(`To share this deployment with your team, copy programId into the shared field of solana-devnet in packages/core/networks.mjs.`);
