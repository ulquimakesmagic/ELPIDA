import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, ZeroAddress } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { feeSplit, buyQuote, sellQuote } from '../packages/core/economics.mjs';

const compiled = compileContracts({ includeMocks: true });
const unit = 1_000_000n;
const source = 'contracts/evm/src/';
const artifact = (name) => compiled[`${source}${name}.sol`][name];
const mined = async (promise) => (await promise).wait();

async function setup(t) {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const [creator, buyer, treasury, reward] = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all([creator, buyer, treasury, reward].map(s => s.getAddress()));
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const quote = await new ContractFactory(mock.abi, mock.evm.bytecode.object, creator).deploy();
  await quote.waitForDeployment();
  const factoryArtifact = artifact('ElpidaFactory');
  const factory = await new ContractFactory(factoryArtifact.abi, factoryArtifact.evm.bytecode.object, creator).deploy(await quote.getAddress(), addresses[2]);
  await factory.waitForDeployment();
  for (const address of addresses.slice(0, 2)) await mined(quote.mint(address, 10_000n * unit));
  await mined(quote.approve(await factory.getAddress(), 10_000n * unit));
  return { provider, creator, buyer, treasury, reward, addresses, quote, factory };
}

async function launch(f, firstBuy = 100n * unit) {
  const receipt = await mined(f.factory.launch('Elpida', 'ELP', firstBuy, 1n, f.addresses[3]));
  const event = receipt.logs.map(log => { try { return f.factory.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === 'Launched');
  assert.ok(event, 'launch must emit token and curve addresses');
  return {
    token: new Contract(event.args.token, artifact('ElpidaToken').abi, f.creator),
    curve: new Contract(event.args.curve, artifact('ElpidaCurve').abi, f.creator),
  };
}

async function invariant(f, token, curve) {
  const address = await curve.getAddress();
  assert.equal(await f.quote.balanceOf(address), await curve.realReserve() + await curve.protocolFees() + await curve.creatorFees(), 'quote balance equals reserve plus owed fees');
  assert.equal(await token.balanceOf(address) + await curve.sold(), await token.totalSupply(), 'curve inventory plus outstanding supply is conserved');
}

test('EVM launch collects 10 USDC and executes the first buy atomically', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f);
  const expected = buyQuote({ gross: 100n * unit, virtualQuote: await curve.virtualQuote(), virtualToken: await curve.virtualToken(), reserve: 0n, sold: 0n });
  assert.equal(await f.quote.balanceOf(f.addresses[2]), 10n * unit);
  assert.equal(await f.quote.balanceOf(f.addresses[0]), 9_890n * unit);
  assert.equal(await token.balanceOf(f.addresses[0]), expected.out);
  assert.equal(await curve.realReserve(), expected.net);
  assert.equal(await f.factory.isElpidaToken(await token.getAddress()), true);
  assert.equal(await f.quote.allowance(await f.factory.getAddress(), await curve.getAddress()), 0n);
  assert.equal(await f.quote.balanceOf(await f.factory.getAddress()), 0n);
  await invariant(f, token, curve);
});

test('EVM launch validates first buy, recipient and funding', async t => {
  const f = await setup(t);
  await assert.rejects(f.factory.launch.staticCall('Elpida', 'ELP', 0n, 0n, f.addresses[3]), /mandatory first buy/);
  await assert.rejects(f.factory.launch.staticCall('Elpida', 'ELP', unit, 0n, ZeroAddress), /reward vault required/);
  await mined(f.quote.approve(await f.factory.getAddress(), 10n * unit));
  await assert.rejects(f.factory.launch.staticCall('Elpida', 'ELP', unit, 0n, f.addresses[3]), /allowance/);
  assert.equal(await f.quote.balanceOf(f.addresses[2]), 0n);
});

test('EVM failed first-buy transaction rolls back launch fee and funding', async t => {
  const f = await setup(t);
  const before = await f.quote.balanceOf(f.addresses[0]);
  await assert.rejects(mined(f.factory.launch('Elpida', 'ELP', 100n * unit, 10n ** 40n, f.addresses[3], { gasLimit: 8_000_000 })), /revert/);
  assert.equal(await f.quote.balanceOf(f.addresses[0]), before);
  assert.equal(await f.quote.balanceOf(f.addresses[2]), 0n);
  assert.equal(await f.quote.balanceOf(await f.factory.getAddress()), 0n);
  const { token, curve } = await launch(f);
  await invariant(f, token, curve);
});

test('EVM buy and sell agree with reference math and enforce slippage', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f);
  const traderCurve = curve.connect(f.buyer);
  const traderToken = token.connect(f.buyer);
  await mined(f.quote.connect(f.buyer).approve(await curve.getAddress(), 1_000n * unit));
  const gross = 75n * unit + 19n;
  const expected = buyQuote({ gross, virtualQuote: await curve.virtualQuote(), virtualToken: await curve.virtualToken(), reserve: await curve.realReserve(), sold: await curve.sold() });
  await assert.rejects(traderCurve.buy.staticCall(gross, expected.out + 1n), /slippage/);
  await mined(traderCurve.buy(gross, expected.out));
  assert.equal(await token.balanceOf(f.addresses[1]), expected.out);
  await mined(traderToken.approve(await curve.getAddress(), expected.out));
  const sell = sellQuote({ tokenIn: expected.out, virtualQuote: await curve.virtualQuote(), virtualToken: await curve.virtualToken(), reserve: await curve.realReserve(), sold: await curve.sold() });
  await assert.rejects(traderCurve.sell.staticCall(expected.out, sell.net + 1n), /slippage/);
  const before = await f.quote.balanceOf(f.addresses[1]);
  await mined(traderCurve.sell(expected.out, sell.net));
  assert.equal(await f.quote.balanceOf(f.addresses[1]), before + sell.net);
  assert.equal(await token.balanceOf(f.addresses[1]), 0n);
  await invariant(f, token, curve);
});

test('EVM fee withdrawal pays fixed recipients and preserves the reserve', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f, 100n * unit + 80n);
  const split = feeSplit(100n * unit + 80n);
  assert.equal(split.creator, split.protocol + 1n, 'odd fee unit belongs to creator');
  const reserve = await curve.realReserve();
  await mined(curve.connect(f.buyer).withdrawFees());
  assert.equal(await f.quote.balanceOf(f.addresses[2]), 10n * unit + split.protocol);
  assert.equal(await f.quote.balanceOf(f.addresses[3]), split.creator);
  assert.equal(await curve.protocolFees(), 0n);
  assert.equal(await curve.creatorFees(), 0n);
  assert.equal(await curve.realReserve(), reserve);
  await mined(curve.withdrawFees());
  assert.equal(await f.quote.balanceOf(f.addresses[3]), split.creator);
  await invariant(f, token, curve);
});

test('EVM failed quote transfers preserve balances and fee claims', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f);
  const p = await curve.protocolFees(), c = await curve.creatorFees();
  await mined(f.quote.setFailTransfers(true));
  await assert.rejects(mined(curve.withdrawFees({ gasLimit: 500_000 })), /revert/);
  assert.equal(await curve.protocolFees(), p);
  assert.equal(await curve.creatorFees(), c);
  await mined(f.quote.connect(f.buyer).approve(await curve.getAddress(), unit));
  await assert.rejects(mined(curve.connect(f.buyer).buy(unit, 1n, { gasLimit: 500_000 })), /revert/);
  await invariant(f, token, curve);
});

test('EVM rejects repeat initialization and invalid or oversized trades', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f);
  await assert.rejects(curve.initialBuy.staticCall(f.addresses[0], unit, 0n), /factory\/initialized/);
  await assert.rejects(curve.buy.staticCall(0n, 0n), /positive buy required/);
  await assert.rejects(curve.quoteSell(0n), /invalid sell/);
  await assert.rejects(curve.quoteSell(await curve.sold() + 1n), /invalid sell/);
  await assert.rejects(curve.quoteBuy(1_000_000_000n * unit), /buy too small\/large/);
  await invariant(f, token, curve);
});

test('EVM reserve and inventory invariants hold across mixed trades and payouts', async t => {
  const f = await setup(t);
  const { token, curve } = await launch(f);
  await mined(f.quote.connect(f.buyer).approve(await curve.getAddress(), 10_000n * unit));
  await mined(token.connect(f.buyer).approve(await curve.getAddress(), 10n ** 40n));
  for (let i = 1n; i <= 12n; i++) {
    await mined(curve.connect(f.buyer).buy((i * 7n + 1n) * unit + i, 1n));
    await invariant(f, token, curve);
    const tokensIn = await token.balanceOf(f.addresses[1]) / 3n;
    await mined(curve.connect(f.buyer).sell(tokensIn, 1n));
    await invariant(f, token, curve);
    if (i % 3n === 0n) {
      await mined(curve.withdrawFees());
      await invariant(f, token, curve);
    }
  }
});

test('EVM factory scales fee and curve to an 18-decimal quote asset (BNB Chain USDC)', async t => {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const [creator, treasury, reward] = await Promise.all([0, 2, 3].map(i => provider.getSigner(i)));
  const mock = compiled['tests/fixtures/MockUSDC.sol'].MockUSDC;
  const quote = await new ContractFactory(mock.abi, mock.evm.bytecode.object, creator).deploy();
  await quote.waitForDeployment();
  await mined(quote.setDecimals(18));
  const fa = artifact('ElpidaFactory');
  const factory = await new ContractFactory(fa.abi, fa.evm.bytecode.object, creator).deploy(await quote.getAddress(), await treasury.getAddress());
  await factory.waitForDeployment();
  const whole = 10n ** 18n;
  assert.equal(await factory.quoteDecimals(), 18n);
  assert.equal(await factory.LAUNCH_FEE(), 10n * whole);
  assert.equal(await factory.VIRTUAL_QUOTE(), 30_000n * whole);
  await mined(quote.mint(await creator.getAddress(), 1_000n * whole));
  await mined(quote.approve(await factory.getAddress(), 1_000n * whole));
  const receipt = await mined(factory.launch('Bnb', 'BNBT', 100n * whole, 1n, await reward.getAddress()));
  const event = receipt.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'Launched');
  const token = new Contract(event.args.token, artifact('ElpidaToken').abi, creator);
  const curve = new Contract(event.args.curve, artifact('ElpidaCurve').abi, creator);
  const expected = buyQuote({ gross: 100n * whole, virtualQuote: 30_000n * whole, virtualToken: await curve.virtualToken(), reserve: 0n, sold: 0n });
  const sixDecimal = buyQuote({ gross: 100n * unit, virtualQuote: 30_000n * unit, virtualToken: await curve.virtualToken(), reserve: 0n, sold: 0n });
  assert.equal(await token.balanceOf(await creator.getAddress()), expected.out);
  assert.ok(expected.out / 10n ** 6n === sixDecimal.out / 10n ** 6n, 'same dollar buy yields the same tokens on 6- and 18-decimal quotes');
  assert.equal(await quote.balanceOf(await treasury.getAddress()), 10n * whole);
  await mined(quote.setDecimals(19));
  await assert.rejects(new ContractFactory(fa.abi, fa.evm.bytecode.object, creator).deploy(await quote.getAddress(), await treasury.getAddress()), /quote decimals/);
});

test('Testnet-only tUSDC has a capped public faucet and works as a launch quote', async t => {
  const f = await setup(t);
  const ta = compiled['contracts/evm/testnet/ElpidaTestUSDC.sol'].ElpidaTestUSDC;
  const tusdc = await new ContractFactory(ta.abi, ta.evm.bytecode.object, f.buyer).deploy();
  await tusdc.waitForDeployment();
  assert.equal(await tusdc.symbol(), 'tUSDC');
  await assert.rejects(tusdc.faucet.staticCall(1_000n * unit + 1n), /faucet limit/);
  await mined(tusdc.faucet(1_000n * unit));
  const fa = artifact('ElpidaFactory');
  const factory = await new ContractFactory(fa.abi, fa.evm.bytecode.object, f.buyer).deploy(await tusdc.getAddress(), f.addresses[2]);
  await factory.waitForDeployment();
  await mined(tusdc.approve(await factory.getAddress(), 35n * unit));
  await mined(factory.launch('Test', 'TST', 25n * unit, 1n, f.addresses[3]));
  assert.equal(await tusdc.balanceOf(f.addresses[2]), 10n * unit);
  assert.equal(await tusdc.balanceOf(f.addresses[1]), 965n * unit);
});
