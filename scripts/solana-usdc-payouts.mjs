#!/usr/bin/env node
// ELPIDA V2 on Solana devnet: stablecoin payouts (Malik, 10–11 November). Run after the program upgrade that adds
// `v2_convert_usdc`. Opens a Raydium CPMM WSOL/USDC pool on the 1% config the program uses (the distributors convert
// their SOL through it) and prints the `v2.usdc` record to pin in deployments/solana-devnet.json.
//
//   node scripts/solana-usdc-payouts.mjs [--usdc 7.5] [--sol <amount>] [--rpc <devnet RPC>] [--keypair <path>]
//
// Without --sol, the SOL side is the USDC amount at the SOL/USD price the V2 pair uses (Pyth), so the pool opens at the
// market price and the keeper's conversions pay fair dollars.
//
// The deployer (local-data/solana-deployer.json by default) pays: the SOL side, Raydium's 0.15 SOL pool-creation fee and
// rent, and the USDC side from its devnet USDC (Circle's devnet faucet: https://faucet.circle.com, Solana Devnet). USDC is
// the one the V2 pair's pricing config names. Devnet only; nothing here touches mainnet.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { createElpidaSolana, parsePriceUpdate, WSOL_MINT, RAYDIUM_MIGRATE_COMPUTE_UNITS } from '../packages/solana/client.mjs';
import { send } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({ options: { sol: { type: 'string' }, usdc: { type: 'string', default: '7.5' }, rpc: { type: 'string' }, keypair: { type: 'string' } } });
const record = JSON.parse(readFileSync(`${root}deployments/solana-devnet.json`, 'utf8'));
if (!record.v2?.config) throw new Error('Set up ELPIDA V2 on devnet first (npm run solana:deploy -- --v2 --keeper <address>).');
if (record.v2.usdc?.pool) { console.log(`Already set up: ${JSON.stringify({ usdc: record.v2.usdc })}`); process.exit(0); }
const connection = new web3.Connection(args.rpc ?? process.env.SOLANA_RPC_URL ?? solanaDevnet.rpcUrl, 'confirmed');
const keypairPath = args.keypair ?? `${root}local-data/solana-deployer.json`;
if (!existsSync(keypairPath)) throw new Error(`No deployer keypair at ${keypairPath}.`);
const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
const client = createElpidaSolana(web3, record.programId, { cluster: 'devnet' });
const toUnits = (v, d) => { const [w, f = ''] = String(v).split('.'); if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > d) throw new Error(`Bad amount ${v}`); return BigInt(w) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d)); };
const usdcAmount = toUnits(args.usdc, 6);

// The USDC is whatever the V2 pair's pricing config names (Circle's devnet USDC).
const pricing = await connection.getAccountInfo(client.pricingPda(record.v2.config));
if (!pricing) throw new Error('The V2 pair has no pricing config; run the V2 setup with pricing first.');
const usdc = new web3.PublicKey(client.decodePricing(pricing.data).usdcMint);
if (usdc.equals(web3.PublicKey.default)) throw new Error('The V2 pricing config names no USDC.');
const held = client.tokenAmount((await connection.getAccountInfo(client.ata(payer.publicKey, usdc)))?.data);
if (held < usdcAmount) throw new Error(`The deployer holds ${held} USDC units of ${usdc.toBase58()}; it needs ${usdcAmount}. Get devnet USDC at https://faucet.circle.com (Solana Devnet) for ${payer.publicKey.toBase58()}.`);
let sol;
if (args.sol) sol = toUnits(args.sol, 9);
else {
  const feed = record.v2.usdPricing?.priceAccount ?? record.usdPricing?.priceAccount;
  const px = feed ? parsePriceUpdate((await connection.getAccountInfo(new web3.PublicKey(feed)))?.data) : null;
  if (!px || px.price <= 0n) throw new Error('Could not read the SOL/USD price; pass --sol <amount> for the SOL side.');
  // usdc (6 decimals) / (price × 10^exponent) SOL, in lamports.
  const e = BigInt(px.exponent), num = usdcAmount * 1000n * (e < 0n ? 10n ** -e : 1n), den = px.price * (e > 0n ? 10n ** e : 1n);
  sol = num / den;
  console.log(`SOL/USD ${(Number(px.price) * 10 ** px.exponent).toFixed(2)}: ${args.usdc} USDC pairs with ${Number(sol) / 1e9} SOL.`);
}
if (sol <= 0n || sol > 2_000_000_000n || usdcAmount <= 0n) throw new Error('Choose up to 2 SOL and a positive USDC amount.');
const lamports = BigInt(await connection.getBalance(payer.publicKey));
if (lamports < sol + 250_000_000n) throw new Error(`The deployer needs ${Number(sol) / 1e9} SOL plus about 0.25 SOL for Raydium's fee and rent; it has ${Number(lamports) / 1e9}.`);

console.log(`Opening a Raydium CPMM WSOL/USDC pool (1%) with ${Number(sol) / 1e9} SOL and ${args.usdc} USDC (${usdc.toBase58()})…`);
const pool = web3.Keypair.generate();
const sig = await send(connection, payer, [client.computeBudget(RAYDIUM_MIGRATE_COMPUTE_UNITS), ...client.createStablePool({ creator: payer.publicKey, pool: pool.publicKey, usdcMint: usdc, solAmount: sol, usdcAmount })], [pool]);
const out = { usdc: { mint: usdc.toBase58(), pool: pool.publicKey.toBase58(), wsol: WSOL_MINT, createdTx: sig } };
console.log('Pool open. Send this to be pinned in deployments/solana-devnet.json (v2.usdc); the keeper then pays USDC:');
console.log(JSON.stringify(out, null, 2));
