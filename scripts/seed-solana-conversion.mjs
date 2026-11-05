// Seeds the Elpida program's SOL/stock conversion pool on Solana devnet, so SOL can pay for stock-pair trades and a
// stock-paired launch's first purchase (docs/SOLANA_STOCK_PAIRING.md). TEST NETWORKS ONLY: the pool exists only in the
// test build of the program; on mainnet the same payments will route through Jupiter.
//
//   node scripts/seed-solana-conversion.mjs --stock-usd 440 --keypair <deploy key>             # 1 SOL per stock
//   node scripts/seed-solana-conversion.mjs --stock-usd 440 --sol 2 --keypair <deploy key>
//   node scripts/seed-solana-conversion.mjs --stock-usd 440 --dry-run                          # plan only
//
// --stock-usd is the price the test stock should trade at, in US dollars (for tTSLAon, Tesla's current share price):
// nothing is assumed. SOL/USD is read from the Pyth price account the program already uses. Only the program's upgrade
// authority can seed; the deployer key is that authority on devnet. Test assets have no value.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { SOLANA_ORACLES } from '../packages/core/usd-oracles.mjs';
import { parsePriceUpdate, TOKEN_2022_PROGRAM } from '../packages/solana/client.mjs';
import { ensureTestConversion } from '../packages/solana/deploy.mjs';
import { conversionSeedPlan } from './lib/solana-conversion-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: args } = parseArgs({ options: {
  cluster: { type: 'string', default: 'devnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
  sol: { type: 'string', default: '1' }, 'stock-usd': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
} });
if (!['devnet', 'localnet'].includes(args.cluster)) throw new Error('Test networks only: --cluster devnet or localnet. Mainnet pays in SOL through Jupiter.');
if (!args['stock-usd']) throw new Error('Give --stock-usd: the US dollar price the test stock should trade at (for tTSLAon, Tesla\'s share price now).');
const localnet = args.cluster === 'localnet';
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (localnet ? 'http://127.0.0.1:8899' : solanaDevnet.rpcUrl);
const record = [`${root}local-data/solana-${args.cluster}.json`, `${root}deployments/solana-${args.cluster}.json`].find(existsSync);
if (!record) throw new Error(`No Solana ${args.cluster} deployment found. Deploy first with scripts/solana-deploy.mjs.`);
const deployment = JSON.parse(readFileSync(record, 'utf8'));
const stocks = (deployment.pairs ?? []).filter(p => p.kind === 'xstock' && p.test && p.tokenProgram === TOKEN_2022_PROGRAM);
if (!stocks.length) throw new Error('No test stock pair in the deployment. Add one with: node scripts/solana-deploy.mjs --upgrade --stock-pairs');

const connection = new web3.Connection(rpcUrl, 'confirmed');
const oracle = SOLANA_ORACLES[args.cluster];
const price = parsePriceUpdate((await connection.getAccountInfo(new web3.PublicKey(oracle.priceAccount)))?.data);
if (!price) throw new Error(`Could not read SOL/USD from ${oracle.priceAccount}.`);
const solUsd = Number(price.price) * 10 ** price.exponent;
console.log(`Cluster ${args.cluster} · program ${deployment.programId} · SOL/USD ${solUsd.toFixed(2)} (Pyth, ${new Date(Number(price.publishTime) * 1000).toISOString()})`);
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${localnet ? '-localnet' : ''}.json`;
const payer = args['dry-run'] && !existsSync(keypairPath) ? null : web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
if (payer) console.log(`Signer ${payer.publicKey.toBase58()} · ${(await connection.getBalance(payer.publicKey)) / web3.LAMPORTS_PER_SOL} SOL`);

for (const pair of stocks) {
  const plan = conversionSeedPlan({ sol: args.sol, solUsd, stockUsd: args['stock-usd'], decimals: pair.decimals });
  console.log(`${pair.symbol}: ${args.sol} SOL + ${Number(plan.stockAmount) / 10 ** pair.decimals} ${pair.symbol} → 1 ${pair.symbol} ≈ ${plan.solPerStock.toFixed(4)} SOL ($${Number(args['stock-usd']).toFixed(2)})${args['dry-run'] ? ' (dry run, nothing sent)' : ''}`);
  if (args['dry-run']) continue;
  try {
    const state = await ensureTestConversion({ connection, payer, programId: new web3.PublicKey(deployment.programId), quoteMint: pair.mint, quoteTokenProgram: pair.tokenProgram, decimals: pair.decimals, solAmount: plan.solAmount, stockAmount: plan.stockAmount, onProgress: m => console.log(`  ${m}`) });
    console.log(`  Pool now holds ${Number(state.solReserve) / web3.LAMPORTS_PER_SOL} SOL and ${Number(state.quoteReserve) / 10 ** pair.decimals} ${pair.symbol}.`);
  } catch (error) {
    const text = String(error?.message ?? error);
    if (/0x65|InstructionFallbackNotFound|101/.test(text)) throw new Error('The devnet program does not have the conversion pool yet. Upgrade it first: node scripts/solana-deploy.mjs --upgrade --keypair <deploy key>');
    if (/0x1770/.test(text)) throw new Error('Only the program\'s upgrade authority can seed the conversion pool. Use the deploy key.');
    throw error;
  }
}
