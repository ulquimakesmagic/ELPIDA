// Creates the testnet wallet the revenue flywheel keeper signs with (docs/REVENUE_FLYWHEEL.md):
//
//   node scripts/flywheel-keeper-key.mjs
//
// Writes local-data/flywheel-keeper-evm.key (a private key). It stays on this computer (local-data/ is git-ignored)
// and is never printed. The script prints only the PUBLIC address to top up. Paste the file's contents into the
// Railway variable ELPIDA_FLYWHEEL_EVM_KEY yourself. An existing file is never overwritten.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const dir = fileURLToPath(new URL('../local-data/', import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}flywheel-keeper-evm.key`;
let address;
if (existsSync(file)) address = new Wallet(readFileSync(file, 'utf8').trim()).address;
else { const w = Wallet.createRandom(); writeFileSync(file, w.privateKey + '\n', { mode: 0o600 }); address = w.address; }
console.log(`Flywheel wallet address (top up with test ETH / tBNB on each testnet): ${address}`);
console.log('Private key written to local-data/flywheel-keeper-evm.key only. Paste it into Railway yourself; never share it.');
