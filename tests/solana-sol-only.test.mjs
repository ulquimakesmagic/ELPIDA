// New Solana launches pair with SOL only, so every new curve graduates to Raydium (decided 1 November 2026). USDC,
// token and stock pairs are not offered for new launches even when the program has their configs; tokens already
// launched on them keep trading on PumpSwap.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import './helpers/browser-modules.mjs';
import { PAIR_LIMITS, SOLANA_LAUNCH_KINDS } from '../packages/core/pairs.mjs';

globalThis.solanaWeb3 = web3;
const { SolanaWallet } = await import('../apps/web/solana-wallet.mjs');

test('only SOL pairs are offered for new Solana launches, with a reason for the others', () => {
  assert.deepEqual([...SOLANA_LAUNCH_KINDS], ['native']);
  const w = Object.create(SolanaWallet.prototype);
  const usdc = { address: web3.Keypair.generate().publicKey, kind: 'usdc', symbol: 'USDC', quoteDecimals: 6, test: false };
  const token = { address: web3.Keypair.generate().publicKey, kind: 'token', symbol: 'TEST', quoteDecimals: 6, test: true };
  Object.assign(w, { configs: new Map([[usdc.address.toBase58(), usdc], [token.address.toBase58(), token]]), net: { name: 'Solana Devnet', deployment: { programId: 'x' } } });
  const options = w.pairOptions();
  for (const kind of ['usdc', 'token', 'xstock']) {
    assert.deepEqual(options[kind].assets, [], `${kind}: not offered even when configured`);
    assert.equal(options[kind].unavailable, PAIR_LIMITS.solana[kind]);
  }
  assert.match(options.usdc.unavailable, /pair with SOL and graduate to Raydium/);
  assert.match(options.usdc.unavailable, /keep trading on PumpSwap/);
});
