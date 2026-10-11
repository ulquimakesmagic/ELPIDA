// Downloads the PumpSwap (pump AMM) program and its GlobalConfig account from Solana Devnet into
// contracts/solana/fixtures, so tests/solana.test.mjs can run real PumpSwap migrations on a local
// solana-test-validator. Run again to refresh after PumpSwap upgrades.
//
//   node scripts/solana-pumpswap-fixtures.mjs   # devnet (default), or solana-pumpswap-fixtures.cmd
//   node scripts/solana-pumpswap-fixtures.mjs --rpc <url>
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as web3 from '@solana/web3.js';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

const { values: args } = parseArgs({ options: { rpc: { type: 'string' } } });
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const out = fileURLToPath(new URL('../contracts/solana/fixtures/', import.meta.url));
mkdirSync(out, { recursive: true });
const connection = new web3.Connection(rpcUrl, 'confirmed');
const program = new web3.PublicKey(PUMP_AMM_PROGRAM);

const programInfo = await connection.getAccountInfo(program);
if (!programInfo?.executable) throw new Error(`PumpSwap program ${PUMP_AMM_PROGRAM} not found on ${rpcUrl}.`);
const programData = new web3.PublicKey(programInfo.data.subarray(4, 36));
const dataInfo = await connection.getAccountInfo(programData);
const elf = dataInfo.data.subarray(45);
writeFileSync(`${out}pump_amm.so`, elf);
console.log(`Saved pump_amm.so (${elf.length.toLocaleString()} bytes, sha256 ${createHash('sha256').update(elf).digest('hex').slice(0, 16)}…)`);

const account = async (address, file) => {
  const info = await connection.getAccountInfo(new web3.PublicKey(address));
  if (!info) throw new Error(`Account ${address} not found.`);
  writeFileSync(`${out}${file}`, `${JSON.stringify({
    pubkey: address,
    account: { lamports: info.lamports, data: [info.data.toString('base64'), 'base64'], owner: info.owner.toBase58(), executable: false, rentEpoch: 0, space: info.data.length },
  }, null, 2)}\n`);
  console.log(`Saved ${file} (${info.data.length} bytes)`);
};
await account(PUMP_GLOBAL_CONFIG, 'pumpswap_global_config.json');
writeFileSync(`${out}SOURCE.txt`, `PumpSwap fixtures fetched from ${rpcUrl.replace(/([?&](api[-_]?key|key|token)=)[^&]+/i, '$1***')} at ${new Date().toISOString()}\nprogram ${PUMP_AMM_PROGRAM} (programdata ${programData.toBase58()}, slot ${dataInfo.data.readBigUInt64LE(4)})\n`);
console.log('Done. These files are only used by the local tests.');
