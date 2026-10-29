// Creates the two testnet wallets the automatic buyback keeper signs with (docs/AUTOMATIC_BUYBACK.md):
//
//   node scripts/buyback-keeper-keys.mjs
//
// Writes local-data/buyback-keeper-evm.key (a private key) and local-data/buyback-keeper-solana.json (a keypair as a
// JSON byte array). Both stay on this computer (local-data/ is git-ignored) and are never printed. The script prints
// only the PUBLIC addresses to fund. Copy each file's contents into the Railway variable of the same purpose
// (ELPIDA_BUYBACK_EVM_KEY, ELPIDA_BUYBACK_SOLANA_KEY) yourself. Existing files are never overwritten.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';

const dir = fileURLToPath(new URL('../local-data/', import.meta.url));
mkdirSync(dir, { recursive: true });
const evmFile = `${dir}buyback-keeper-evm.key`, solFile = `${dir}buyback-keeper-solana.json`;

let evmAddress, solAddress;
if (existsSync(evmFile)) evmAddress = new Wallet(readFileSync(evmFile, 'utf8').trim()).address;
else { const w = Wallet.createRandom(); writeFileSync(evmFile, w.privateKey + '\n', { mode: 0o600 }); evmAddress = w.address; }
if (existsSync(solFile)) solAddress = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(solFile, 'utf8')))).publicKey.toBase58();
else { const k = Keypair.generate(); writeFileSync(solFile, JSON.stringify([...k.secretKey]) + '\n', { mode: 0o600 }); solAddress = k.publicKey.toBase58(); }

console.log(`EVM keeper address (fund with test ETH / tBNB on each testnet): ${evmAddress}`);
console.log(`Solana keeper address (fund with devnet SOL):                ${solAddress}`);
console.log(`Private keys written to local-data/ only. Paste their contents into Railway yourself; never share them.`);
