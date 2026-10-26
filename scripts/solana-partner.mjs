// Early-partner tiers on Solana (docs/DESIGN_PARTNER_TIERS.md). The SOL pair's treasury registers a creator wallet.
//
//   npm run solana:partner -- --creator <wallet> --bps 2000 --days 60        # Elite for 60 days
//   npm run solana:partner -- --creator <wallet> --bps 1000 --expires <unix> # Partner until a unix time
//   npm run solana:partner -- --creator <wallet> --bps 0 --expires 0         # end the tier early
//   npm run solana:partner -- --creator <wallet> --status                    # read the record only
//
// Options: --cluster devnet|mainnet|localnet (default devnet), --rpc <url> (or SOLANA_RPC_URL), --keypair <file>
// (default local-data/solana-deployer[-cluster].json; on devnet the SOL pair's treasury is the deploy key),
// --export prints the instruction for a multisig treasury instead of sending it. Only future launches are affected.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
import { solanaDevnet } from '../packages/core/networks.mjs';
import { createElpidaSolana, WSOL_MINT, PARTNER_BPS, MAX_PARTNER_WINDOW_SECS } from '../packages/solana/client.mjs';
import { send } from '../packages/solana/deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Validates the terms exactly as the program does; returns { buybackBps, expiresAt }. */
export function partnerTerms({ bps, expires, days }, now = Math.floor(Date.now() / 1000)) {
  const buybackBps = Number(bps);
  if (buybackBps === 0) {
    if (expires !== undefined && Number(expires) !== 0) throw new Error('Ending a tier takes --bps 0 --expires 0.');
    return { buybackBps: 0, expiresAt: 0 };
  }
  if (!PARTNER_BPS.includes(buybackBps)) throw new Error('--bps must be 1000 (Partner), 2000 (Elite) or 0 (end).');
  const expiresAt = days !== undefined ? now + Math.round(Number(days) * 86_400) : Number(expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_PARTNER_WINDOW_SECS) throw new Error('The expiry must be in the future and at most 180 days ahead (--days 1-180 or --expires <unix seconds>).');
  return { buybackBps, expiresAt };
}

async function main() {
  const { values: args } = parseArgs({ options: {
    cluster: { type: 'string', default: 'devnet' }, rpc: { type: 'string' }, keypair: { type: 'string' },
    creator: { type: 'string' }, bps: { type: 'string' }, expires: { type: 'string' }, days: { type: 'string' },
    status: { type: 'boolean', default: false }, export: { type: 'boolean', default: false },
  } });
  const cluster = args.cluster;
  if (!['mainnet', 'devnet', 'localnet'].includes(cluster)) throw new Error('--cluster must be devnet, mainnet or localnet');
  if (!args.creator) throw new Error('--creator <wallet> is required.');
  const creator = new web3.PublicKey(args.creator.trim());
  const recordPath = [`${root}local-data/solana-${cluster}.json`, `${root}deployments/solana-${cluster}.json`].find(existsSync);
  if (!recordPath) throw new Error(`No deployment record for ${cluster}.`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? (cluster === 'localnet' ? 'http://127.0.0.1:8899' : cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : solanaDevnet.rpcUrl);
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const client = createElpidaSolana(web3, new web3.PublicKey(record.programId));
  const show = async () => {
    const p = client.decodePartner((await connection.getAccountInfo(client.partnerPda(creator)))?.data);
    console.log(p && p.buybackBps ? `${creator.toBase58()}: ${p.buybackBps / 100}% buyback and burn until ${new Date(p.expiresAt * 1000).toISOString()}${p.live ? '' : ' (expired)'}` : `${creator.toBase58()}: standard (no tier)`);
  };
  if (args.status) return show();
  if (!await client.supportsPartnerTiers(connection, new web3.PublicKey(record.treasury))) throw new Error('This cluster runs a program without partner tiers. Upgrade it first (npm run solana:deploy -- --upgrade).');
  const terms = partnerTerms({ bps: args.bps, expires: args.expires, days: args.days });
  const config = client.decodeConfig((await connection.getAccountInfo(client.configFor(WSOL_MINT))).data);
  if (args.export) {
    const ix = client.setPartner({ authority: config.treasury, creator, ...terms });
    console.log(JSON.stringify({ programId: ix.programId.toBase58(), accounts: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase64: Buffer.from(ix.data).toString('base64') }, null, 2));
    return;
  }
  const keypairPath = args.keypair ?? `${root}local-data/solana-deployer${cluster === 'localnet' ? '-localnet' : cluster === 'mainnet' ? '-mainnet' : ''}.json`;
  const signer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  if (!signer.publicKey.equals(config.treasury)) throw new Error(`Only the SOL pair's treasury (${config.treasury.toBase58()}) can register partners; this keypair is ${signer.publicKey.toBase58()}.`);
  const signature = await send(connection, signer, [client.setPartner({ authority: signer.publicKey, creator, ...terms })]);
  console.log(`Sent ${signature}`);
  await show();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exit(1); });
