// Mainnet checklist C3: a launchpad whose immutable treasury is a Safe. The connected wallet deploys (gas only, no
// powers); the treasury-only setup comes back as a Safe Transaction Builder batch; once the Safe executes it,
// launches work and launch fees go to the Safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, Interface, ZeroAddress, parseEther } from 'ethers';
import './helpers/browser-modules.mjs';
import { readSafe, treasuryError, safeBatch } from '../apps/web/safe-batch.mjs';
import { dexFixture, mined, art, fixtureArt, TEST_URI } from './helpers/dex-fixture.mjs';
const { TestnetWallet } = await import('../apps/web/wallet.mjs');
const { PublicRpcSigner } = await import('../apps/web/public-rpc-signer.mjs');

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
test('treasury rules: a different treasury must be a Safe; mainnet needs a Safe with at least two signers', () => {
  assert.equal(treasuryError({ treasury: A, connected: A }), null, 'testnet: this wallet is fine');
  assert.match(treasuryError({ mainnet: true, treasury: A, connected: A }), /must be a multisig/);
  assert.match(treasuryError({ treasury: B, connected: A, safe: { contract: false } }), /not a contract/);
  assert.match(treasuryError({ treasury: B, connected: A, safe: { contract: true, safe: false } }), /not a Safe/);
  assert.match(treasuryError({ mainnet: true, treasury: B, connected: A, safe: { contract: true, safe: true, threshold: 1, owners: [A] } }), /at least 2/);
  assert.equal(treasuryError({ mainnet: true, treasury: B, connected: A, safe: { contract: true, safe: true, threshold: 2, owners: [A, B] } }), null);
  const batch = safeBatch({ chainId: 1, safe: B, name: 'n', description: 'd', transactions: [{ to: A, data: '0x12' }], now: 5 });
  assert.deepEqual(batch, { version: '1.0', chainId: '1', createdAt: 5, meta: { name: 'n', description: 'd', txBuilderVersion: '1.16.5', createdFromSafeAddress: B, createdFromOwnerAddress: '' }, transactions: [{ to: A, value: '0', data: '0x12', contractMethod: null, contractInputsValues: null }] });
  assert.throws(() => safeBatch({ chainId: 1, safe: B, name: 'n', description: 'd', transactions: [] }), /Nothing/);
});

function walletOn(f, signer, net = { chainId: 31337, key: 'local', name: 'Local', nativeCurrency: { symbol: 'ETH' } }) {
  const store = new Map(); globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const c = n => ({ abi: art(n).abi, bytecode: '0x' + art(n).evm.bytecode.object });
  const w = Object.create(TestnetWallet.prototype);
  Object.assign(w, {
    net, provider: f.provider, onProgress: () => {}, launches: new Map(),
    _eth: { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [w.address] : null },
    config: { oracles: { [net.key]: { feed: f.feed.target, maxAge: 86400, usdc: f.usdc.target, available: true } }, publicDexes: { [net.key]: f.dex.config },
      contracts: { adapter: c('ElpidaV3MigrationAdapter'), atomicFactory: c('ElpidaAtomicDexFactory'), dexFactory: c('ElpidaDexFactory'), legacyFactory: c('ElpidaBetaFactory'), dexCurve: { abi: art('ElpidaDexCurve').abi }, legacyCurve: { abi: art('ElpidaBetaCurve').abi }, quote: { abi: art('ElpidaToken').abi } } },
  });
  Object.defineProperty(w, 'eth', { get: () => w._eth });
  return signer.getAddress().then(address => { w.address = address; w.signer = new PublicRpcSigner(signer, f.provider, { pollMs: 5 }); return w; });
}

test('the real deploy with a Safe treasury: deployer gets no powers, the Safe executes the batch, then launches pay the Safe', async t => {
  const f = await dexFixture(t), [deployer, owner1, owner2] = [f.signers[0], f.signers[1], f.signers[2]];
  const safe = await new ContractFactory(fixtureArt('MockSafe').abi, fixtureArt('MockSafe').evm.bytecode.object, deployer).deploy([f.addresses[1], f.addresses[2]], 2);
  await safe.waitForDeployment();
  assert.deepEqual(await readSafe(Contract, f.provider, safe.target), { contract: true, safe: true, owners: [f.addresses[1], f.addresses[2]], threshold: 2 });
  assert.deepEqual(await readSafe(Contract, f.provider, f.addresses[3]), { contract: false, safe: false });
  const w = await walletOn(f, deployer);
  await assert.rejects(w.deploy({ treasury: f.addresses[3] }), /not a contract/);
  const result = await w.deploy({ treasury: safe.target });
  assert.match(result.message, /Safe .* as its treasury \(2 of 2 signatures\)/);
  const factory = new Contract(w.deployment.factory, art('ElpidaAtomicDexFactory').abi, f.provider);
  assert.equal(await factory.treasury(), safe.target, 'the Safe is the immutable treasury');
  assert.equal(w.deployment.treasury, safe.target);
  assert.equal(await factory.usdFeed(), ZeroAddress, 'the deployer could not configure anything');
  // The batch: activate USD pricing, then approve USDC trading.
  const batch = result.safeBatch, i = new Interface(art('ElpidaAtomicDexFactory').abi);
  assert.equal(batch.meta.createdFromSafeAddress, safe.target); assert.equal(batch.chainId, '31337');
  assert.deepEqual(batch.transactions.map(x => i.parseTransaction({ data: x.data }).name), ['configureUsdPricing', 'approveQuote']);
  await assert.rejects(new Contract(factory.target, i, deployer).configureUsdPricing(f.feed.target, 86400, f.usdc.target), /PricingFixed|revert/, 'the deployer cannot run it');
  for (const tx of batch.transactions) await mined(new Contract(safe.target, fixtureArt('MockSafe').abi, owner1).exec(tx.to, BigInt(tx.value), tx.data));
  assert.equal(await factory.usdFeed(), f.feed.target); assert.notEqual((await factory.approvedQuotes(f.usdc.target)).adapter, ZeroAddress);
  assert.equal(await w.treasuryBatch(new Contract(factory.target, i, w.signer)), null, 'nothing left for the treasury');
  // A launch now pays its fee to the Safe.
  const before = await f.provider.getBalance(safe.target), fee = await factory.launchFee(), buy = parseEther('0.01');
  await mined(new Contract(factory.target, i, owner2).launchWithPayment('Safe', 'SAFE', ZeroAddress, buy, 0, f.addresses[2], TEST_URI, false, { value: fee + buy }));
  assert.equal(await f.provider.getBalance(safe.target) - before, fee, 'the launch fee went to the Safe');
});

test('mainnet refuses the connected wallet or a one-signer Safe as treasury', async t => {
  const f = await dexFixture(t), deployer = f.signers[0];
  const single = await new ContractFactory(fixtureArt('MockSafe').abi, fixtureArt('MockSafe').evm.bytecode.object, deployer).deploy([f.addresses[1]], 1);
  await single.waitForDeployment();
  const w = await walletOn(f, deployer, { chainId: 31337, key: 'local', name: 'Local', mainnet: true, nativeCurrency: { symbol: 'ETH' } });
  await assert.rejects(w.deploy({}), /must be a multisig/);
  await assert.rejects(w.deploy({ treasury: single.target }), /at least 2/);
});
