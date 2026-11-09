// Creates the ELPIDA V2 keeper's Solana key (docs/V2_0_SOLANA.md, step 4a). The server keeper uses it to post reward
// rounds, sweep SOL and run the flywheel on Solana; it never holds reward funds (those stay in the vault PDAs).
//
//   node scripts/solana-keeper-key.mjs            # creates local-data/solana-v2-keeper.json (once) and prints its address
//
// The file is the secret key: it stays in local-data (git-ignored) and is never printed. To give it to the server,
// open the file and paste its whole content (a JSON array of numbers) into Railway as ELPIDA_V2_KEEPER_SOLANA_KEY.
// Fund the printed address with about 1 SOL on devnet for network fees and rent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const path = `${root}local-data/solana-v2-keeper.json`;
let keypair;
if (existsSync(path)) keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
else {
  mkdirSync(`${root}local-data`, { recursive: true });
  keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
}
console.log(`ELPIDA V2 keeper (Solana): ${keypair.publicKey.toBase58()}`);
console.log(`Secret key file: ${path} (never share it; paste its content into Railway as ELPIDA_V2_KEEPER_SOLANA_KEY).`);
console.log(`Next: npm run solana:deploy -- --upgrade --v2 --keeper ${keypair.publicKey.toBase58()} --keypair <deployer key path>`);
