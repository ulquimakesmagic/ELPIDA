import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
const compiled = compileContracts({ includeMocks: true });
const artifact = name => compiled[`contracts/evm/src/${name}.sol`][name];
const mined = async promise => (await promise).wait();
const unit = 1_000_000n;
async function setup(t, decimals = 6) {
  const connection = await network.create('localTest');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const signers = await Promise.all([0,1,2,3].map(i => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const deploy = async (a, ...args) => { const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signers[0]).deploy(...args); await c.waitForDeployment(); return c; };
  const quote = await deploy(compiled['tests/fixtures/MockUSDC.sol'].MockUSDC);
  await mined(quote.setDecimals(decimals));
  const factory = await deploy(artifact('ElpidaLockedFactory'), await quote.getAddress(), addresses[2]);
  const scale = 10n ** BigInt(decimals);
  for (const a of addresses.slice(0,2)) await mined(quote.mint(a, 10000n * scale));
  await mined(quote.approve(await factory.getAddress(), 10000n * scale));
  return { provider, signers, addresses, quote, factory };
}
async function launch(f) {
  const receipt = await mined(f.factory.launch('Locked Garden','LOCK',100n * unit,25n * unit,1n,f.addresses[3]));
  const event = receipt.logs.map(log => { try { return f.factory.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'Launched');
  return { pool: new Contract(event.args.pool, artifact('ElpidaLockedPool').abi, f.signers[0]), token: new Contract(event.args.token, artifact('ElpidaToken').abi, f.signers[0]) };
}
async function invariant(f, pool, token) {
  const address = await pool.getAddress();
  assert.equal(await f.quote.balanceOf(address), await pool.realReserve() + await pool.protocolFees() + await pool.creatorFees());
  assert.equal(await token.balanceOf(address), await pool.tokenReserve());
  assert.equal(await pool.tokenReserve() + await pool.sold(), await token.totalSupply());
}
test('locked launch funds actual reserves and first buy atomically', async t => {
  const f = await setup(t); const {pool,token} = await launch(f);
  assert.equal(await pool.liquidityLocked(), true);
  assert.equal(await pool.initialQuote(),100n * unit);
  assert.equal(await pool.realReserve(),124687500n);
  assert.equal(await f.quote.balanceOf(f.addresses[0]),9865n * unit);
  assert.equal(await f.quote.balanceOf(f.addresses[2]),10n * unit);
  assert.equal(await f.quote.balanceOf(await f.factory.getAddress()),0n);
  assert.equal(await f.quote.allowance(await f.factory.getAddress(), await pool.getAddress()),0n);
  await invariant(f,pool,token);
});
test('locked factory uses actual quote decimals for funding and pool pricing',async t => {
  const f = await setup(t,18); const whole = 10n**18n;
  assert.equal(await f.factory.quoteDecimals(),18n);
  assert.equal(await f.factory.LAUNCH_FEE(),10n*whole);
  const receipt = await mined(f.factory.launch('Scaled','SCALE',100n*whole,25n*whole,1n,f.addresses[3]));
  const event = receipt.logs.map(log => { try { return f.factory.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'Launched');
  const pool = new Contract(event.args.pool,artifact('ElpidaLockedPool').abi,f.signers[0]);
  const token = new Contract(event.args.token,artifact('ElpidaToken').abi,f.signers[0]);
  const net = 25n*whole-25n*whole*125n/10000n;
  assert.equal(await token.balanceOf(f.addresses[0]),await token.totalSupply()*net/(100n*whole+net));
  assert.equal(await f.quote.balanceOf(f.addresses[0]),9865n*whole);
  await invariant(f,pool,token);
});
test('zero seed, unauthorized reinitialization and failed first buy cannot leave a partial launch',async t => {
  const f = await setup(t);
  await assert.rejects(f.factory.launch.staticCall('X','X',0n,unit,0n,f.addresses[3]),/liquidity required/);
  const balance = await f.quote.balanceOf(f.addresses[0]);
  await assert.rejects(mined(f.factory.launch('X','X',100n*unit,unit,10n**40n,f.addresses[3],{gasLimit:8000000})),/revert/);
  assert.equal(await f.quote.balanceOf(f.addresses[0]),balance);
  assert.equal(await f.quote.balanceOf(f.addresses[2]),0n);
  const {pool} = await launch(f);
  await assert.rejects(pool.initialize.staticCall(unit),/factory\/initialized/);
  await assert.rejects(pool.initialBuy.staticCall(f.addresses[1],unit,0n),/factory\/first buy/);
});
test('permissionless fee claims leave both locked reserves intact and cannot redirect payouts',async t => {
  const f = await setup(t); const {pool,token} = await launch(f);
  const q = await pool.realReserve(), r = await pool.tokenReserve();
  const p = await pool.protocolFees(), c = await pool.creatorFees();
  await mined(pool.connect(f.signers[1]).withdrawFees());
  assert.equal(await f.quote.balanceOf(f.addresses[2]),10n*unit+p);
  assert.equal(await f.quote.balanceOf(f.addresses[3]),c);
  assert.equal(await f.quote.balanceOf(f.addresses[1]),10000n*unit);
  assert.equal(await pool.realReserve(),q); assert.equal(await pool.tokenReserve(),r);
  await mined(pool.withdrawFees());
  assert.equal(await f.quote.balanceOf(f.addresses[3]),c);
  // Calls to common removal/admin selectors must revert on the deployed bytecode.
  for (const signature of ['withdraw(uint256)','removeLiquidity(uint256)','rescue(address,uint256)','upgradeTo(address)']) {
    const iface = new (await import('ethers')).Interface([`function ${signature}`]);
    const values = signature.includes('address') ? signature.includes('uint256') ? [f.addresses[1],1n] : [f.addresses[1]] : [1n];
    await assert.rejects(f.signers[0].sendTransaction({to:await pool.getAddress(),data:iface.encodeFunctionData(signature.split('(')[0],values)}));
  }
  await invariant(f,pool,token);
});
test('buys and full circulating-supply redemption conserve pool backing and preserve seeded liquidity',async t => {
  const f = await setup(t); const {pool,token} = await launch(f);
  const k = await pool.realReserve() * await pool.tokenReserve();
  await mined(f.quote.connect(f.signers[1]).approve(await pool.getAddress(),10n*unit));
  const [out] = await pool.quoteBuy(10n*unit);
  await assert.rejects(pool.connect(f.signers[1]).buy.staticCall(10n*unit,out+1n),/slippage/);
  await mined(pool.connect(f.signers[1]).buy(10n*unit,out));
  assert.ok(await pool.realReserve() * await pool.tokenReserve() >= k);
  for (const s of f.signers.slice(0,2)) {
    const held = await token.balanceOf(await s.getAddress());
    await mined(token.connect(s).approve(await pool.getAddress(),held));
    const [net] = await pool.quoteSell(held);
    await mined(pool.connect(s).sell(held,net));
    await invariant(f,pool,token);
  }
  assert.equal(await pool.sold(),0n);
  assert.equal(await pool.tokenReserve(),await token.totalSupply());
  assert.ok(await pool.realReserve() >= await pool.initialQuote());
});
