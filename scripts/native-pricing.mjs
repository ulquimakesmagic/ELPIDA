// Applies config/native-pricing.json: every chain charges and prices launches in its own coin.
//
//   node scripts/native-pricing.mjs --chain solana-devnet          # show current vs new prices (no change)
//   node scripts/native-pricing.mjs --chain solana-devnet --yes    # apply them (signed by the upgrade authority)
//   node scripts/native-pricing.mjs --chain solana-mainnet --export  # print the instructions for a Squads multisig
//
// Solana: updates the SOL pair config (curve FDVs and the SOL creation fee) and the SOL creation fee of
// every other pair config. New values apply to launches made afterwards; live pools keep theirs.
// EVM: pricing is set on each factory by its owner (treasury) wallet: open the site, pick the network and
// press "Apply native pricing" in the network menu. This script only prints the values for EVM chains.
// Options: --rpc <url> (or SOLANA_RPC_URL), --keypair <file> (default local-data/solana-deployer-<cluster>.json).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { solanaPairTemplates } from '../packages/core/pairs.mjs';
import { loadPricing, solanaPricing, evmPricing, EVM_LEGACY_END_MULTIPLE } from '../packages/core/pricing.mjs';
import { send, pricingUpdates, upgradeAuthority, exportInstruction } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args } = parseArgs({ options: {
  chain: { type: 'string' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  yes: { type: 'boolean', default: false }, export: { type: 'boolean', default: false },
} });
const pricing = loadPricing();
const chain = args.chain ?? '';
if (!chain) {
  console.log('Native pricing (config/native-pricing.json):');
  for (const [cluster, p] of Object.entries(pricing.solana)) console.log(`  solana-${cluster.padEnd(18)} fee ${p.launchFee} SOL, FDV ${p.startFdv} → ${p.endFdv} SOL`);
  for (const [key, p] of Object.entries(pricing.evm)) console.log(`  ${key.padEnd(25)} fee ${p.launchFee}, FDV ${p.startFdv} → ${Number(p.startFdv) * EVM_LEGACY_END_MULTIPLE} (native coin, legacy model 8 only)`);
  console.log('\nModel 10 EVM factories are oracle-priced: $10 fee, fixed USD starting FDV and a 10x curve (packages/core/curve-model.mjs).');
  console.log('\nApply with --chain <name> (Solana) or from the site as the launchpad owner (EVM).');
  process.exit(0);
}
if (!chain.startsWith('solana-')) {
  const p = evmPricing(chain, pricing);
  console.log(`${chain}: fee ${p.launchFee}, starting FDV ${p.startFdv} (virtual reserve ${p.virtualQuoteWei} wei).`);
  console.log('EVM factories are priced by their owner wallet: open the site, pick this network, open the network menu and press "Apply native pricing".');
  process.exit(0);
}
const cluster = chain.slice('solana-'.length);
if (!['devnet', 'localnet', 'mainnet'].includes(cluster)) throw new Error('--chain must be solana-devnet, solana-localnet, solana-mainnet or an EVM network key.');
const native = solanaPricing(cluster, pricing);
const recordPath = [`${root}local-data/solana-${cluster}.json`, `${root}deployments/solana-${cluster}.json`].find(existsSync);
if (!recordPath) throw new Error(`No Solana ${cluster} deployment found. Run npm run solana:deploy -- --cluster ${cluster} first.`);
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const statePath = `${root}local-data/solana-${cluster}-deploy-state.json`;
const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).testAssets ?? {} : Object.fromEntries((record.pairs ?? []).filter(p => p.test).map(p => [p.key, p.mint]));
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (cluster === 'localnet' ? 'http://127.0.0.1:8899' : cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : solanaDevnet.rpcUrl);
const connection = new web3.Connection(rpcUrl, 'confirmed');
const programId = new web3.PublicKey(record.programId);
const authority = await upgradeAuthority(connection, programId);
if (!authority) throw new Error('The program is immutable: pair configs can no longer be repriced.');
const updates = await pricingUpdates({ connection, programId, authority, templates: solanaPairTemplates(native, { test: cluster !== 'mainnet' }), saved });
const sol = lamports => (Number(lamports) / 1e9).toString();
console.log(`Solana ${cluster}: ${native.launchFee} SOL creation fee, SOL pair FDV ${native.startFdv} → ${native.endFdv} SOL.`);
console.log(`Upgrade authority: ${authority.toBase58()}`);
if (!updates.length) { console.log('Every pair config already matches config/native-pricing.json.'); process.exit(0); }
for (const u of updates) console.log(`  ${u.template.symbol}: fee ${sol(u.before.launchFee)} → ${sol(u.params.launchFee)} SOL; virtual reserve ${u.before.virtualQuote} → ${u.params.virtualQuote}`);
if (args.export) {
  console.log('\nInstructions for the multisig (add each as a custom instruction, then approve):');
  console.log(JSON.stringify(updates.map(u => exportInstruction(u.instruction)), null, 2));
  process.exit(0);
}
if (!args.yes) { console.log('\nRun again with --yes to apply (or --export for a multisig).'); process.exit(0); }
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${cluster === 'localnet' ? '-localnet' : cluster === 'mainnet' ? '-mainnet' : ''}.json`;
const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
if (!payer.publicKey.equals(authority)) throw new Error(`The upgrade authority is ${authority.toBase58()}, not this keypair. Use --export to get the instructions for it.`);
for (const u of updates) { await send(connection, payer, [u.instruction]); console.log(`${u.template.symbol} repriced.`); }
console.log('Done. New launches use the new prices; existing tokens are unchanged.');
