// Graduated SOL-pair tokens trade on their locked Raydium CPMM pool (1% tier) from the token page. The on-chain part
// (migration, swaps, harvests and partner buybacks against the real Raydium program) is in solana.test.mjs; this covers
// the browser wallet: quotes, slippage, balance checks and the instructions it asks the wallet to sign.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import './helpers/browser-modules.mjs';
import { createElpidaSolana, raydiumQuote, raydiumCreationCost, STATUS_MIGRATED, RAYDIUM, DISCRIMINATORS } from '../packages/solana/client.mjs';

globalThis.solanaWeb3 = web3;
const { SolanaWallet } = await import('../apps/web/solana-wallet.mjs');
const PROGRAM = 'ANkA5pytoVkiKQbjzd5NdPWKgmwfsihNJvSfg3vtKLNz';

function wallet({ tokens = 5_000_000n * 10n ** 6n, sol = 2_000_000_000n, openTime = 0n } = {}) {
  const log = { sent: [] };
  const w = Object.create(SolanaWallet.prototype);
  const me = web3.Keypair.generate().publicKey;
  const client = createElpidaSolana(web3, PROGRAM);
  Object.assign(w, {
    publicKey: me, net: { name: 'Solana Devnet', cluster: 'devnet', deployment: { programId: PROGRAM } }, _client: client,
    connection: { getAccountInfo: async () => { const data = Buffer.alloc(72); data.writeBigUInt64LE(tokens, 64); return { data }; } },
    quoteBalance: async () => sol,
    sendInstructions: async (instructions, extra, message) => { log.sent.push({ instructions, message }); return 'SIG'; },
  });
  const state = { venue: 'Raydium', state: { lpSupply: 10n ** 12n, base: 200_000_000n * 10n ** 6n, quote: 1_000_000_000n, openTime } };
  return { w, log, state, me, client };
}
const config = { quoteDecimals: 9, wsol: true, symbol: 'SOL' };
const mint = web3.Keypair.generate().publicKey;
const pool = { status: STATUS_MIGRATED, symbol: 'RAYTK', mint };
const swapOf = instructions => instructions.find(ix => ix.programId?.toBase58() === RAYDIUM.devnet.program);

test('a graduated SOL-pair token buys and sells on its Raydium pool in one signed transaction, at the quoted price less slippage', async () => {
  const { w, log, state, me, client } = wallet();
  const bought = await w.raydiumTrade({ pool, config, action: 'buy', body: { amount: '0.1', slippage: '1' }, state });
  assert.equal(bought.message, 'Bought RAYTK on Raydium.');
  const [tx] = log.sent, swap = swapOf(tx.instructions), r = client.raydiumAccounts(mint);
  const q = raydiumQuote(100_000_000n, state.state.quote, state.state.base);
  assert.deepEqual([...swap.data.subarray(0, 8)], DISCRIMINATORS.raydiumSwapBaseInput);
  assert.equal(swap.data.readBigUInt64LE(8), 100_000_000n, '0.1 SOL in');
  assert.equal(swap.data.readBigUInt64LE(16), q.out * 9_900n / 10_000n, 'at least the quote less 1%');
  assert.equal(swap.keys[0].pubkey.toBase58(), me.toBase58()); assert.ok(swap.keys[0].isSigner);
  assert.equal(swap.keys[3].pubkey.toBase58(), r.pool.toBase58(), 'the token\'s own Elpida-locked pool');
  assert.equal(swap.keys[4].pubkey.toBase58(), client.ata(me, client.wsol).toBase58(), 'pays from wrapped SOL');
  assert.equal(swap.keys[6].pubkey.toBase58(), r.quoteVault.toBase58()); assert.equal(swap.keys[7].pubkey.toBase58(), r.baseVault.toBase58());
  assert.equal(tx.instructions.at(-1).programId.toBase58(), client.tokenProgram.toBase58(), 'unwraps leftover SOL at the end');
  assert.match(tx.message, /buy on Raydium/);
  const sold = await w.raydiumTrade({ pool, config, action: 'sell', body: { amount: '1000', slippage: '0.5' }, state });
  assert.equal(sold.message, 'Sold RAYTK on Raydium.');
  const sell = swapOf(log.sent[1].instructions);
  assert.equal(sell.data.readBigUInt64LE(8), 1_000n * 10n ** 6n);
  assert.equal(sell.keys[6].pubkey.toBase58(), r.baseVault.toBase58());
  assert.equal(sell.data.readBigUInt64LE(16), raydiumQuote(1_000n * 10n ** 6n, state.state.base, state.state.quote).out * 9_950n / 10_000n);
});

test('Raydium trades are refused before the wallet is asked when the pool is not open, or funds, amount or slippage are wrong', async () => {
  let { w, log, state } = wallet({ openTime: BigInt(Math.floor(Date.now() / 1000) + 3600) });
  await assert.rejects(w.raydiumTrade({ pool, config, action: 'buy', body: { amount: '0.1', slippage: '1' }, state }), /opens for trading/);
  ({ w, log, state } = wallet({ sol: 100_000_000n }));
  await assert.rejects(w.raydiumTrade({ pool, config, action: 'buy', body: { amount: '0.1', slippage: '1' }, state }), /Not enough SOL/);
  ({ w, log, state } = wallet({ tokens: 10n }));
  await assert.rejects(w.raydiumTrade({ pool, config, action: 'sell', body: { amount: '1', slippage: '1' }, state }), /You hold 0\.00001 RAYTK/);
  await assert.rejects(w.raydiumTrade({ pool, config, action: 'buy', body: { amount: '0', slippage: '1' }, state }), /greater than zero/);
  await assert.rejects(w.raydiumTrade({ pool, config, action: 'buy', body: { amount: '1', slippage: '9' }, state }), /Slippage/);
  assert.equal(log.sent.length, 0, 'nothing was sent to the wallet');
});

test('SOL pairs graduate to Raydium, other pairs to PumpSwap; the migrating wallet lends Raydium\'s fee and rent', () => {
  const { w } = wallet();
  assert.equal(w.venueOf({ wsol: true }), 'Raydium'); assert.equal(w.venueOf({ wsol: false }), 'PumpSwap');
  assert.equal(raydiumCreationCost(), 192_156_720n);
  assert.ok(w.migrationAdvance({ wsol: true }) > raydiumCreationCost());
  const refs = { address: w.client.configFor(w.client.wsol), quoteMint: w.client.wsol, treasury: web3.Keypair.generate().publicKey };
  assert.deepEqual([...w.migrateIx({ wsol: true }, refs, mint).data], DISCRIMINATORS.migrateToRaydium);
  assert.deepEqual([...w.migrateIx({ wsol: false }, refs, mint).data], DISCRIMINATORS.migrateToPumpswap);
  assert.match(w.dexUrl('POOL', 'Raydium', 'MINT'), /POOL/, 'test networks link the explorer');
  w.net = { ...w.net, cluster: 'mainnet-beta', mainnet: true };
  assert.equal(w.dexUrl('POOL', 'Raydium', 'MINT'), 'https://raydium.io/swap/?inputMint=sol&outputMint=MINT');
});

test('the client selects Raydium mainnet accounts only for the mainnet build', () => {
  const dev = createElpidaSolana(web3, PROGRAM), main = createElpidaSolana(web3, PROGRAM, { cluster: 'mainnet' });
  assert.equal(dev.raydium.program, RAYDIUM.devnet.program); assert.equal(main.raydium.program, RAYDIUM.mainnet.program);
  const a = dev.raydiumAccounts(mint), b = main.raydiumAccounts(mint);
  assert.equal(a.pool.toBase58(), b.pool.toBase58(), 'the pool is Elpida\'s own PDA on both');
  assert.notEqual(a.lpMint.toBase58(), b.lpMint.toBase58());
  const [pda] = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], new web3.PublicKey(RAYDIUM.mainnet.program));
  assert.equal(pda.toBase58(), RAYDIUM.mainnet.authority);
  for (const [cluster, index] of [['devnet', 3], ['mainnet', 1]]) {
    const seed = Buffer.alloc(2); seed.writeUInt16BE(index);
    assert.equal(web3.PublicKey.findProgramAddressSync([Buffer.from('amm_config'), seed], new web3.PublicKey(RAYDIUM[cluster].program))[0].toBase58(), RAYDIUM[cluster].ammConfig, `${cluster} 1% config is index ${index}`);
  }
  assert.equal(raydiumQuote(1_000_000n, 10n ** 9n, 10n ** 9n).fee, 10_000n, '1% fee, rounded up');
});

test('claiming fees of a graduated ELPIDA V2 token signs withdraw_v2_fees and the V2 Raydium harvest, never the old ones', async () => {
  const { w, log, client } = wallet();
  const config = { address: web3.Keypair.generate().publicKey, quoteDecimals: 9, wsol: true, symbol: 'SOL', treasury: web3.Keypair.generate().publicKey, quoteMint: new web3.PublicKey('So11111111111111111111111111111111111111112'), quoteTokenProgram: new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
  const v2Pool = { status: STATUS_MIGRATED, symbol: 'SHIB', mint, reward: web3.Keypair.generate().publicKey, protocolFees: 0n, creatorFees: 0n, v2: { feeBps: 125, accrued: 1_000_000n, paid: [0n, 0n, 0n, 0n, 0n] } };
  Object.assign(w, { loadConfig: async () => config, configOf: () => config, refsOf: c => c, freshPool: async () => ({ mint, pool: v2Pool }),
    pumpStates: async () => new Map([['x', { venue: 'Raydium', harvestable: 10n ** 9n, migration: { pendingBuyback: 5n * 10n ** 9n }, state: { lpSupply: 10n ** 12n, base: 200_000_000n * 10n ** 6n, quote: 10n ** 10n } }]]),
    fitsOneTransaction: async () => true });
  const r = await w.transact('withdraw', { token: mint.toBase58() });
  assert.match(r.message, /Fees claimed/);
  const ixs = log.sent[0].instructions, has = name => ixs.some(ix => Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(DISCRIMINATORS[name])));
  assert.ok(has('withdrawV2Fees') && !has('withdrawFees'), 'the V2 fee ledger');
  const harvest = ixs.find(ix => Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(DISCRIMINATORS.harvestRaydiumFees)));
  assert.equal(harvest.keys.length, client.harvestRaydiumFees({ payer: w.publicKey, config, mint, reward: v2Pool.reward, v2: true }).at(-1).keys.length, 'the V2 harvest (with the pool\'s SOL account)');
  assert.ok(!has('raydiumBuyback'), 'no partner buyback for V2 pools');
});
