import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ContractFactory, parseUnits, formatUnits } from 'ethers';
import { createRuntime } from '../apps/api/curve-runtime.mjs';
import { EVM_TEST_PAIRS } from '../packages/core/pairs.mjs';

// Mirrors TestnetWallet.setupTestPairs and its paired launch on a local DEX launchpad: the treasury deploys
// the labelled test assets, gives each a migration adapter and approves it; creators then launch against it.
test('EVM test xStock and paired token: owner approval, faucet, paired launch at the template FDV, kind indexed', async t => {
  const r = await createRuntime({ dex: true, seed: false }); t.after(() => r.close());
  const treasury = await r.provider.getSigner(2), creator = await r.provider.getSigner(0);
  const factory = new Contract(r.config.local.factory, r.config.contracts.dexFactory.abi, treasury);
  assert.equal((await factory.treasury()).toLowerCase(), (await treasury.getAddress()).toLowerCase());
  const supply = await factory.TOKEN_SUPPLY(), vt = await factory.VIRTUAL_TOKEN();
  const launched = [];
  for (const t of EVM_TEST_PAIRS) {
    const asset = await new ContractFactory(r.config.contracts.testAsset.abi, r.config.contracts.testAsset.bytecode, treasury).deploy(t.name, t.symbol, t.kind, t.decimals, BigInt(t.faucet));
    await asset.waitForDeployment();
    assert.equal(await asset.pairKind(), t.kind);
    const adapter = await new ContractFactory(r.config.contracts.adapter.abi, r.config.contracts.adapter.bytecode, treasury).deploy(r.config.dex.manager, asset.target, 10000);
    await adapter.waitForDeployment();
    const virtualQuote = parseUnits(t.startFdv, t.decimals) * vt / supply;
    await (await factory.approveQuote(asset.target, virtualQuote, adapter.target)).wait();
    await assert.rejects(factory.connect(creator).approveQuote(asset.target, virtualQuote, adapter.target), /quote approval/);
    const events = await factory.queryFilter(factory.filters.QuoteApproved());
    assert.ok(events.some(e => e.args.asset === asset.target && e.args.virtualQuote === virtualQuote));
    // Creator: free test funds, then the same approvals and call the browser makes.
    const mine = asset.connect(creator), limit = await asset.FAUCET_LIMIT();
    await (await mine.faucet(limit)).wait();
    await assert.rejects(mine.faucet(limit + 1n), /faucet limit/);
    const fee = await factory.launchFee();
    const firstBuy = parseUnits(t.startFdv, t.decimals) / 100n;
    await (await mine.approve(factory.target, firstBuy)).wait();
    const net = firstBuy - firstBuy * 125n / 10000n, out = vt * net / (virtualQuote + net);
    const receipt = await (await factory.connect(creator).launchPaired(`Pair ${t.symbol}`, t.key.replace(/\W/g, '').slice(0, 8).toUpperCase(), asset.target, firstBuy, out * 9950n / 10000n, await creator.getAddress(), { value: fee })).wait();
    const event = receipt.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Launched');
    const curve = new Contract(event.args.curve, r.config.contracts.dexCurve.abi, r.provider);
    assert.equal(await curve.quote(), asset.target);
    const startFdv = Number(formatUnits(await curve.virtualQuote(), t.decimals)) / Number(formatUnits(await curve.virtualToken(), 18)) * 1e9;
    assert.ok(Math.abs(startFdv / Number(t.startFdv) - 1) < 1e-9, `${t.symbol} starts at ${t.startFdv} ${t.symbol} FDV (${startFdv})`);
    launched.push([event.args.token.toLowerCase(), t]);
  }
  await r.indexer.sync();
  for (const [token, t] of launched) {
    const listing = r.indexer.listings().find(l => l.address === token);
    assert.equal(listing.pair, t.kind); assert.equal(listing.quoteSymbol, t.symbol);
  }
});
