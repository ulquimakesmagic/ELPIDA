// Early-partner tiers (docs/DESIGN_PARTNER_TIERS.md): the treasury registers a launching wallet with a 10% (Partner)
// or 20% (Elite) buyback-and-burn share and an expiry. Tokens it launches before the expiry carry that share for
// life: on every curve trade the creator still gets 50%, the burn share buys tokens at the curve price and sends them
// to the dead address, and the protocol gets the rest. A buyback never completes the curve, and every quote unit
// stays accounted for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, parseEther, formatEther } from 'ethers';
import { createRuntime } from '../apps/api/curve-runtime.mjs';

const DEAD = '0x000000000000000000000000000000000000dEaD';
const SUPPLY = 10n ** 27n;

async function setup(t) {
  const runtime = await createRuntime({ seed: false, dex: true });
  t.after(() => runtime.close());
  const abi = runtime.config.contracts.dexFactory.abi;
  const reader = new Contract(runtime.indexer.factory, abi, runtime.provider);
  const treasuryAddress = await reader.treasury();
  const factory = new Contract(runtime.indexer.factory, abi, await runtime.provider.getSigner(treasuryAddress));
  const stranger = new Contract(runtime.indexer.factory, abi, await runtime.provider.getSigner(1));
  const partner = runtime.config.accounts[1].address, standard = runtime.config.accounts[0].address;
  const now = async () => BigInt((await runtime.provider.getBlock('latest')).timestamp);
  const launch = async (account, symbol, firstBuy = '0.01') => {
    const r = await runtime.transact('launch', { name: `Tier ${symbol}`, symbol, pair: 'native', firstBuy, account });
    const listing = runtime.indexer.listings().find(row => row.address.toLowerCase() === r.token.toLowerCase());
    const curve = new Contract(listing.curve, runtime.config.contracts.dexCurve.abi, runtime.provider);
    const token = new Contract(r.token, runtime.config.contracts.token.abi, runtime.provider);
    return { token: r.token, curve, erc20: token };
  };
  return { runtime, factory, stranger, partner, standard, now, launch };
}

test('only the treasury registers tiers, within the allowed shares and window; tiers expire and can be ended', async t => {
  const { runtime, factory, stranger, partner, now } = await setup(t);
  const day = 86400n;
  await assert.rejects(stranger.setPartner(partner, 2000, (await now()) + 30n * day), /owner only/);
  for (const [bps, ahead] of [[1500, 30n], [3000, 30n], [1000, 0n], [2000, 181n]]) {
    await assert.rejects(factory.setPartner(partner, bps, (await now()) + ahead * day), /partner terms/, `${bps} bps, ${ahead} days`);
  }
  await assert.rejects(factory.setPartner(partner, 0, 5), /partner terms/, 'ending takes (0, 0)');
  const expiry = (await now()) + 60n * day;
  await (await factory.setPartner(partner, 2000, expiry)).wait();
  assert.equal(await factory.buybackShareOf(partner), 2000n);
  assert.deepEqual([...await factory.partners(partner)].map(Number), [2000, Number(expiry)]);
  await runtime.provider.send('evm_increaseTime', [61 * 86400]); await runtime.provider.send('evm_mine', []);
  assert.equal(await factory.buybackShareOf(partner), 0n, 'expired');
  await (await factory.setPartner(partner, 1000, (await now()) + day)).wait();
  assert.equal(await factory.buybackShareOf(partner), 1000n);
  await (await factory.setPartner(partner, 0, 0)).wait();
  assert.equal(await factory.buybackShareOf(partner), 0n, 'ended');
  assert.equal(await factory.launchBuybackBps(), 0n, 'zero outside a launch');
  assert.equal(await factory.PARTNER_TIERS_VERSION(), 1n);
});

test('a partner launch burns on every trade, the creator keeps 50%, and every unit is accounted for', async t => {
  const { runtime, factory, partner, now, launch } = await setup(t);
  await (await factory.setPartner(partner, 2000, (await now()) + 60n * 86400n)).wait();
  const elite = await launch('1', 'ELITE');
  const standard = await launch('0', 'STD');
  assert.equal(await elite.curve.buybackBps(), 2000n, 'the partner wallet launched it');
  assert.equal(await standard.curve.buybackBps(), 0n, 'anyone else is standard');
  // Ending the tier later does not change a token already launched.
  await (await factory.setPartner(partner, 0, 0)).wait();
  assert.equal(await elite.curve.buybackBps(), 2000n);

  await runtime.provider.send('evm_increaseTime', [61]); await runtime.provider.send('evm_mine', []);
  const before = { creator: await elite.curve.creatorFees(), protocol: await elite.curve.protocolFees(), dead: await elite.erc20.balanceOf(DEAD) };
  const trades = [['buy', '0.05', '0'], ['buy', '0.2', '1'], ['sell', '1000000', '0'], ['buy', '0.07', '1']];
  let base = 0n;
  for (const [side, amount, account] of trades) {
    const spentBefore = await elite.curve.buybackQuoteSpent(), bonusBefore = await elite.curve.liquidityBonus();
    const c0 = await elite.curve.creatorFees(), p0 = await elite.curve.protocolFees();
    await runtime.transact(side, { token: elite.token, amount, slippage: '5', account });
    const c = (await elite.curve.creatorFees()) - c0, p = (await elite.curve.protocolFees()) - p0;
    const burn = (await elite.curve.buybackQuoteSpent()) - spentBefore + (await elite.curve.liquidityBonus()) - bonusBefore;
    const tradeBase = c + p + burn;
    assert.ok(c >= tradeBase / 2n && c <= tradeBase / 2n + 1n, `${side}: creator keeps half`);
    assert.equal(burn, tradeBase * 2000n / 10000n, `${side}: 20% of the fee buys back and burns`);
    base += tradeBase;
  }
  const burned = await elite.curve.buybackBurned();
  assert.ok(burned > 0n, 'tokens were burned');
  // The launch's own first buy burns too (before the snapshot above), so compare totals: a new token starts with
  // nothing at the dead address.
  assert.equal(await elite.erc20.balanceOf(DEAD), burned, 'every burned token sits at the dead address');
  assert.ok((await elite.erc20.balanceOf(DEAD)) > before.dead, 'and the trades above burned more');
  assert.ok((await elite.curve.creatorFees()) - before.creator >= base / 2n);

  // Exact backing: the curve's ETH is the reserve plus every fee ledger, with the buyback paid into the reserve.
  const held = await runtime.provider.getBalance(await elite.curve.getAddress());
  const owed = (await elite.curve.realReserve()) + (await elite.curve.protocolFees()) + (await elite.curve.creatorFees()) + (await elite.curve.liquidityBonus());
  assert.equal(held, owed);
  // Tokens are conserved: curve inventory + every holder + the dead address = supply.
  const curveBalance = await elite.erc20.balanceOf(await elite.curve.getAddress());
  assert.equal(curveBalance, SUPPLY - (await elite.curve.sold()), 'the curve holds exactly what has not been sold or burned');

  // The standard token pays no burn and splits 50/50 as before.
  await runtime.transact('buy', { token: standard.token, amount: '0.05', slippage: '5', account: '1' });
  assert.equal(await standard.curve.buybackBurned(), 0n);
  const sc = await standard.curve.creatorFees(), sp = await standard.curve.protocolFees();
  assert.ok(sc - sp <= 1n && sc >= sp);

  // The public index labels both: the tier fixed at launch and the tokens burned so far.
  await runtime.indexer.sync();
  const rows = runtime.indexer.listings(), row = address => rows.find(r => r.address.toLowerCase() === address.toLowerCase());
  assert.equal(row(elite.token).buybackBps, 2000);
  assert.equal(row(elite.token).burned, formatEther(await elite.curve.buybackBurned()));
  assert.equal(row(standard.token).buybackBps, 0);
  assert.equal(row(standard.token).burned, undefined);
});

test('a buyback never completes the curve; the completing trade does, and graduation still works', async t => {
  const { runtime, factory, partner, now, launch } = await setup(t);
  await (await factory.setPartner(partner, 2000, (await now()) + 30n * 86400n)).wait();
  const elite = await launch('1', 'FULL');
  await runtime.provider.send('evm_increaseTime', [61]); await runtime.provider.send('evm_mine', []);
  const cap = await elite.curve.SALE_CAP();
  // Buy almost everything: the curve stays open, buybacks keep burning.
  const remaining = await elite.curve.remainingAtBaseFee();
  await runtime.transact('buy', { token: elite.token, amount: (Number(remaining) * 0.97 / 1e18).toFixed(18), slippage: '5', account: '0' });
  assert.equal(await elite.curve.complete(), false);
  assert.ok((await elite.curve.sold()) < cap);
  // The final buy completes it; its own burn share cannot (it goes to the locked-liquidity bonus).
  const bonusBefore = await elite.curve.liquidityBonus();
  const rest = await elite.curve.completionQuote();
  await runtime.transact('buy', { token: elite.token, amount: (Number(rest + parseEther('0.01')) / 1e18).toFixed(18), slippage: '5', account: '0' });
  assert.equal(await elite.curve.sold(), cap, 'exactly the sale cap');
  assert.ok((await elite.curve.liquidityBonus()) > bonusBefore, 'the last burn share went to locked liquidity');
  const pool = await elite.curve.pool();
  if (/^0x0{40}$/i.test(pool)) await runtime.transact('graduate', { token: elite.token, account: '0' });
  assert.notEqual(await elite.curve.pool(), '0x' + '0'.repeat(40), 'graduated into the pool');
  assert.equal(await elite.erc20.balanceOf(await elite.curve.getAddress()), 0n, 'no tokens left on the curve');
  // After graduation the index adds the LP fee splitter's burns and queue to the curve's.
  await runtime.indexer.sync();
  const row = runtime.indexer.listings().find(r => r.address.toLowerCase() === elite.token.toLowerCase());
  const splitter = new Contract(await elite.curve.feeSplitter(), ['function burned() view returns(uint256)'], runtime.provider);
  assert.equal(row.graduated, true); assert.equal(row.buybackBps, 2000);
  assert.equal(row.burned, formatEther(await elite.curve.buybackBurned() + await splitter.burned()));
  assert.equal(typeof row.pendingBuyback, 'string');
});
