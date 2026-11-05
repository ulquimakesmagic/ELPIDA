// New Solana launches pair with SOL (graduating to Raydium, decided 1 November 2026) or with a tokenized stock approved
// in the operator panel (completing into the program's locked pool, decided 4 November 2026). USDC and token pairs are
// not offered for new launches even when the program has their configs; tokens already launched on them keep trading.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as web3 from '@solana/web3.js';
import './helpers/browser-modules.mjs';
import { PAIR_LIMITS, SOLANA_LAUNCH_KINDS, EQUITY_PROVIDERS } from '../packages/core/pairs.mjs';
import { mintControls, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../packages/solana/client.mjs';

globalThis.solanaWeb3 = web3;
const { SolanaWallet } = await import('../apps/web/solana-wallet.mjs');

const key = () => web3.Keypair.generate().publicKey;
function wallet(configs) {
  const w = Object.create(SolanaWallet.prototype);
  Object.assign(w, { configs: new Map(configs.map(c => [c.address.toBase58(), c])), net: { name: 'Solana Devnet', deployment: { programId: 'x' } } });
  return w;
}
const stock = (extra = {}) => ({ address: key(), quoteMint: key(), kind: 'xstock', symbol: 'tTSLAon', name: 'Elpida test Ondo-style TSLA stock (no value)', quoteDecimals: 9, test: true, faucet: '25',
  virtualQuote: 1n, virtualToken: 1n, curveSupply: 1n, baseFeeBps: 125, launchFee: 1n, lockedPool: true, controls: { paused: false, hookProgram: null }, ...extra });

test('Solana launches offer SOL and approved stocks; USDC and token pairs stay off with a reason', () => {
  assert.deepEqual([...SOLANA_LAUNCH_KINDS], ['native', 'xstock']);
  const usdc = { address: key(), kind: 'usdc', symbol: 'USDC', quoteDecimals: 6, test: false };
  const token = { address: key(), kind: 'token', symbol: 'TEST', quoteDecimals: 6, test: true };
  const options = wallet([usdc, token]).pairOptions();
  for (const kind of ['usdc', 'token']) {
    assert.deepEqual(options[kind].assets, [], `${kind}: not offered even when configured`);
    assert.equal(options[kind].unavailable, PAIR_LIMITS.solana[kind]);
  }
  assert.match(options.usdc.unavailable, /pair with SOL \(graduating to Raydium\) or an approved tokenized stock/);
  assert.match(options.usdc.unavailable, /keep trading on PumpSwap/);
  assert.match(options.xstock.unavailable, /approved one at a time in the operator panel/);
  assert.equal(EQUITY_PROVIDERS['solana-devnet'], 'Ondo Global Markets');
});

test('a Solana stock pair is offered only while its mint can trade: locked-pool venue, not paused, no transfer hook', () => {
  const ok = wallet([stock()]).pairOptions().xstock;
  assert.equal(ok.assets.length, 1);
  assert.equal(ok.assets[0].stock.provider, 'ondo-test'); assert.equal(ok.assets[0].lockedPool, true);
  assert.equal(ok.assets[0].faucet.action, 'faucet');
  const paused = wallet([stock({ controls: { paused: true, hookProgram: null } })]).pairOptions().xstock;
  assert.deepEqual(paused.assets, []); assert.match(paused.unavailable, /paused/);
  const hooked = wallet([stock({ controls: { paused: false, hookProgram: key().toBase58() } })]).pairOptions().xstock;
  assert.deepEqual(hooked.assets, []); assert.match(hooked.unavailable, /transfer hook/);
  assert.deepEqual(wallet([stock({ lockedPool: false })]).pairOptions().xstock.assets, [], 'a stock mint the program would send to PumpSwap is never offered');
});

test('mintControls reads the issuer\'s pause flag and transfer-hook program from raw Token-2022 mint data', () => {
  const mint = (paused, hook) => {
    const tlv = (kind, value) => { const h = Buffer.alloc(4); h.writeUInt16LE(kind, 0); h.writeUInt16LE(value.length, 2); return Buffer.concat([h, value]); };
    return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), tlv(4, Buffer.alloc(65)), tlv(14, Buffer.concat([Buffer.alloc(32, 9), hook ?? Buffer.alloc(32)])), tlv(25, Buffer.alloc(56)), tlv(26, Buffer.concat([Buffer.alloc(32, 9), Buffer.from([paused ? 1 : 0])]))]);
  };
  assert.deepEqual(mintControls(mint(false), TOKEN_2022_PROGRAM), { paused: false, hookProgram: null });
  assert.equal(mintControls(mint(true), TOKEN_2022_PROGRAM).paused, true);
  const hook = key();
  assert.equal(mintControls(mint(false, Buffer.from(hook.toBytes())), TOKEN_2022_PROGRAM, b => new web3.PublicKey(b).toBase58()).hookProgram, hook.toBase58());
  assert.deepEqual(mintControls(mint(true), TOKEN_PROGRAM), { paused: false, hookProgram: null }, 'classic SPL mints have no such controls');
  assert.deepEqual(mintControls(null, TOKEN_2022_PROGRAM), { paused: false, hookProgram: null });
});
