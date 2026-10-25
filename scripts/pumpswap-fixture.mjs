// Refreshes contracts/solana/fixtures/pumpswap_pool.json from a live PumpSwap pool.
//
// The program decodes PumpSwap's pool account at fixed offsets (vaults @139..171 and @171..203, lp_supply @203,
// protocol_fees @271, creator_fees @279). If PumpSwap changes that layout, those offsets silently point at the wrong
// bytes. tests/pumpswap-layout.test.mjs decodes this fixture at the same offsets and asserts the result matches what
// the chain said, so a refreshed fixture that no longer decodes is a red build rather than a surprise after graduation.
//
//   node scripts/pumpswap-fixture.mjs [pool-address]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const RPC = process.env.ELPIDA_SOLANA_RPC_READONLY ?? 'https://api.mainnet-beta.solana.com';
const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** A recent pool: the newest transaction on the program mentions one. */
async function newestPool() {
  // Not every program transaction touches a pool the first way round (admin calls, config changes), so look at a
  // few recent ones and at every account they mention.
  const discriminator = createHash('sha256').update('account:Pool').digest().subarray(0, 8);
  for (const signature of await rpc('getSignaturesForAddress', [PROGRAM, { limit: 5 }])) {
    const tx = await rpc('getTransaction', [signature.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    for (const key of (tx?.transaction?.message?.accountKeys ?? []).map(entry => entry.pubkey ?? entry)) {
      const info = await rpc('getAccountInfo', [key, { encoding: 'base64', dataSlice: { offset: 0, length: 300 } }]);
      if (!info?.value || info.value.owner !== PROGRAM) continue;
      const head = Buffer.from(info.value.data[0], 'base64');
      if (head.length >= 8 && head.subarray(0, 8).equals(discriminator)) return key;
    }
  }
  throw new Error('no pool account in recent transactions; pass a pool address explicitly');
}

const BS58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buffer) {
  let value = 0n;
  for (const byte of buffer) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) { out = BS58[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of buffer) { if (byte !== 0) break; out = '1' + out; }
  return out;
}

const address = process.argv[2] ?? await newestPool();
const [account, slot] = await Promise.all([
  rpc('getAccountInfo', [address, { encoding: 'base64' }]),
  rpc('getSlot', [{ commitment: 'finalized' }]),
]);
if (!account?.value) throw new Error('pool account not found');
const data = Buffer.from(account.value.data[0], 'base64');

const decoded = {
  baseVault: base58(data.subarray(139, 171)),
  quoteVault: base58(data.subarray(171, 203)),
  lpSupply: data.readBigUInt64LE(203).toString(),
  protocolFees: data.readBigUInt64LE(271).toString(),
  creatorFees: data.readBigUInt64LE(279).toString(),
};

/** The vaults must be real token accounts, or the offsets are wrong. */
async function vaultInfo(pubkey) {
  const info = await rpc('getAccountInfo', [pubkey, { encoding: 'jsonParsed' }]);
  if (!info?.value) throw new Error(`vault ${pubkey} does not exist`);
  const parsed = info.value.data.parsed?.info ?? {};
  return { owner: info.value.owner, mint: parsed.mint ?? null, amount: parsed.tokenAmount?.amount ?? null };
}

const fixture = {
  source: RPC,
  program: PROGRAM,
  address,
  slot,
  fetchedAt: new Date().toISOString(),
  discriminator: 'account:Pool',
  note: 'A live PumpSwap pool account. tests/pumpswap-layout.test.mjs decodes it at the offsets the program hard-codes.',
  data: data.toString('base64'),
  length: data.length,
  decoded,
  vaults: { base: await vaultInfo(decoded.baseVault), quote: await vaultInfo(decoded.quoteVault) },
};

mkdirSync(join(root, 'contracts/solana/fixtures'), { recursive: true });
writeFileSync(join(root, 'contracts/solana/fixtures/pumpswap_pool.json'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({ address, length: data.length, decoded, vaults: fixture.vaults }));
