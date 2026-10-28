// Downloads Raydium's CPMM program and its 1% AmmConfig account from Solana Devnet into contracts/solana/fixtures,
// so tests/solana.test.mjs can graduate SOL-paired curves into a real Raydium pool on a local solana-test-validator.
// Run again to refresh after Raydium upgrades the devnet program.
//
//   node scripts/solana-raydium-fixtures.mjs              # devnet (default)
//   node scripts/solana-raydium-fixtures.mjs --rpc <url>
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';

export const RAYDIUM_CPMM_DEVNET = 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb';
/** AmmConfig: 8-byte discriminator, bump u8, disable_create_pool bool, index u16, trade_fee_rate u64 (1e6 = 100%), ... */
const AMM_CONFIG_SIZE = 236;
const ONE_PERCENT = 10_000n;

const { values: args } = parseArgs({ options: { rpc: { type: 'string' } } });
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const out = fileURLToPath(new URL('../contracts/solana/fixtures/', import.meta.url));
mkdirSync(out, { recursive: true });
const connection = new web3.Connection(rpcUrl, 'confirmed');
const program = new web3.PublicKey(RAYDIUM_CPMM_DEVNET);

const programInfo = await connection.getAccountInfo(program);
if (!programInfo?.executable) throw new Error(`Raydium CPMM ${RAYDIUM_CPMM_DEVNET} not found on ${rpcUrl}.`);
const programData = new web3.PublicKey(programInfo.data.subarray(4, 36));
const dataInfo = await connection.getAccountInfo(programData);
const slot = dataInfo.data.readBigUInt64LE(4);
const program_ = dataInfo.data.subarray(45);
writeFileSync(`${out}raydium_cpmm.so`, program_);
const hash = createHash('sha256').update(program_).digest('hex');
console.log(`Saved raydium_cpmm.so (${program_.length.toLocaleString()} bytes, sha256 ${hash.slice(0, 16)}…, deployed at slot ${slot})`);

const configs = await connection.getProgramAccounts(program, { filters: [{ dataSize: AMM_CONFIG_SIZE }] });
const onePercent = configs.filter(({ account }) => account.data.readBigUInt64LE(12) === ONE_PERCENT && account.data[9] === 0)
  .sort((a, b) => a.account.data.readUInt16LE(10) - b.account.data.readUInt16LE(10))[0];
if (!onePercent) throw new Error('No enabled 1% AmmConfig on this cluster.');
const { pubkey, account } = onePercent;
writeFileSync(`${out}raydium_amm_config_1pct.json`, `${JSON.stringify({
  pubkey: pubkey.toBase58(),
  account: { lamports: account.lamports, data: [account.data.toString('base64'), 'base64'], owner: account.owner.toBase58(), executable: false, rentEpoch: 0, space: account.data.length },
}, null, 2)}\n`);
console.log(`Saved raydium_amm_config_1pct.json (${pubkey.toBase58()}, index ${account.data.readUInt16LE(10)}, create fee ${Number(account.data.readBigUInt64LE(36)) / 1e9} SOL)`);

writeFileSync(`${out}RAYDIUM_SOURCE.txt`, `Raydium CPMM fixtures fetched from ${rpcUrl.replace(/([?&](api[-_]?key|key|token)=)[^&]+/i, '$1***')} at ${new Date().toISOString()}
program ${RAYDIUM_CPMM_DEVNET} (programdata ${programData.toBase58()}, slot ${slot}), sha256 ${hash}
1% AmmConfig ${pubkey.toBase58()}
`);
console.log('Done. Attach contracts/solana/fixtures/raydium_cpmm.so and raydium_amm_config_1pct.json in the chat (or commit them).');
