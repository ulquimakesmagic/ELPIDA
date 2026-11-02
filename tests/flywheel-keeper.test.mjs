// Revenue flywheel (docs/REVENUE_FLYWHEEL.md): a wallet the treasury tops up buys the top ten eligible tokens by market
// cap and sends what it buys to the dead address. Ten equal slots, capped by depth; the curve is never completed; a
// pool order waits while the price is away from its average; every order is journalled before it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, parseEther } from 'ethers';
import { planFlywheelCycle, FLYWHEEL_POLICY } from '../packages/core/revenue-flywheel.mjs';
import { FlywheelKeeper, evmFlywheelWorker, DEAD, FLYWHEEL_EVM_CHAINS, configuredFlywheelKeeper } from '../apps/api/flywheel-keeper.mjs';
import { routerAbi } from '../packages/core/dex-router.mjs';
import { dexFixture, launch, complete, mined } from './helpers/dex-fixture.mjs';

const DAY = 86_400;
const tok = (address, cap, extra = {}) => ({ address, symbol: address.toUpperCase(), pair: 'native', graduated: false, complete: false, curve: 'c-' + address, created: 0, marketCap: BigInt(cap), remainingBuy: 10n ** 18n, poolReserve: 0n, ...extra });

test('planner: ten equal slots for the ten largest eligible tokens, capped by depth; the rest stays unallocated', () => {
  const tokens = Array.from({ length: 12 }, (_, i) => tok('t' + i, 1000 + i));
  const plan = planFlywheelCycle({ chain: 'x', budget: 1000n, tokens, now: 2 * DAY });
  assert.equal(plan.perSlot, 100n);
  assert.deepEqual(plan.orders.map(o => o.token), ['t11', 't10', 't9', 't8', 't7', 't6', 't5', 't4', 't3', 't2']);
  assert.ok(plan.orders.every(o => o.spend === 100n && o.venue === 'curve'));
  assert.equal(plan.unallocated, 0n);
  // Depth caps: 25% of what completes a curve, 0.5% of a pool's quote balance.
  const capped = planFlywheelCycle({ chain: 'x', budget: 10_000n, tokens: [tok('curve', 5, { remainingBuy: 400n }), tok('pool', 9, { graduated: true, pool: 'p', poolReserve: 20_000n })], now: 2 * DAY });
  assert.deepEqual(capped.orders.map(o => [o.token, o.venue, o.spend]), [['pool', 'pool', 100n], ['curve', 'curve', 100n]]);
  assert.equal(capped.unallocated, 10_000n - 200n, 'unspent slots stay in the wallet');
});

test('planner: only native pairs, a day old, with a market, unrestricted; duplicates and ties are deterministic', () => {
  const tokens = [tok('young', 50, { created: 2 * DAY * 1000 - 1000 }), tok('usdc', 50, { pair: 'usdc' }), tok('done', 50, { complete: true }), tok('nopool', 50, { graduated: true, pool: null }),
    tok('paused', 50, { restricted: true }), tok('zero', 0), tok('b', 7), tok('a', 7), tok('A', 99)];
  const plan = planFlywheelCycle({ chain: 'x', budget: 100n, tokens, now: 2 * DAY });
  assert.deepEqual(plan.orders.map(o => o.token), ['a', 'b'], 'A is a duplicate of a by address; ties break on address');
  assert.equal(FLYWHEEL_POLICY.slots, 10);
  assert.throws(() => planFlywheelCycle({ chain: 'x', budget: -1n, tokens: [], now: 0 }), /Invalid/);
});

async function market(t) {
  const f = await dexFixture(t, { factoryName: 'ElpidaAtomicDexFactory' });
  const a = await launch(f, { symbol: 'AAA' }), b = await launch(f, { symbol: 'BBB' }), c = await launch(f, { symbol: 'CCC' });
  await f.advance(61);
  await mined(a.curve.connect(f.signers[1]).buy(parseEther('1'), 0, { value: parseEther('1') }));
  await mined(c.curve.connect(f.signers[1]).buy(parseEther('0.2'), 0, { value: parseEther('0.2') }));
  await complete(f, b, { signer: f.signers[1] });
  await f.advance(DAY + 60);
  const keeper = f.signers[3];
  const listing = async (l, cap) => {
    const graduated = await l.curve.complete(), pool = graduated ? await l.curve.pool() : null;
    return { address: l.token.target, symbol: await l.token.symbol(), pair: 'native', graduated, complete: graduated, pool, curve: l.curve.target, created: 1000,
      circulatingMarketCapQuote: cap, remainingBuy: graduated ? '0' : (Number(await l.curve.completionQuote()) / 1e18).toFixed(18), reserve: pool ? (Number(await f.dex.weth.balanceOf(pool)) / 1e18).toFixed(18) : '0' };
  };
  const listings = async () => [await listing(a, '20'), await listing(b, '50'), await listing(c, '5')];
  const worker = evmFlywheelWorker({ chain: 'local', chainId: 31337, signer: keeper, listings, dex: f.dex.config });
  return { f, a, b, c, keeper, worker };
}

test('a cycle buys each eligible token on its curve or pool and sends exactly what it bought to the dead address', async t => {
  const { f, a, b, c, worker } = await market(t);
  const now = (await f.provider.getBlock('latest')).timestamp * 1000;
  const k = new FlywheelKeeper({ workers: [worker], maxPerCycle: parseEther('1'), gasReserve: parseEther('0.01'), now: () => now });
  t.after(() => k.close());
  const dead = await Promise.all([a, b, c].map(l => l.token.balanceOf(DEAD)));
  const walletBefore = await f.provider.getBalance(f.addresses[3]);
  await k.runCycle(worker);
  const orders = k.db.prepare('SELECT * FROM flywheel_orders ORDER BY rank').all();
  assert.deepEqual(orders.map(o => [o.symbol, o.venue, o.status]), [['BBB', 'pool', 'burned'], ['AAA', 'curve', 'burned'], ['CCC', 'curve', 'burned']], 'ranked by market cap');
  for (const [i, l] of [b, a, c].entries()) {
    const sent = (await l.token.balanceOf(DEAD)) - dead[[a, b, c].indexOf(l)];
    assert.equal(sent, BigInt(orders[i].bought), `${orders[i].symbol}: everything bought went to the dead address`);
    assert.equal(await l.token.balanceOf(f.addresses[3]), 0n, 'the keeper keeps none');
  }
  const pool = await b.curve.pool(), poolSlot = BigInt(orders[0].spend);
  assert.ok(poolSlot <= (await f.dex.weth.balanceOf(pool)) * 50n / 10_000n + parseEther('0.001'), 'the pool order is at most about 0.5% of its depth');
  assert.equal(BigInt(orders[1].spend), parseEther('1') / 10n, 'a curve slot is a tenth of the cycle budget');
  assert.equal(await a.curve.complete(), false, 'the flywheel never completes a curve');
  const spent = orders.reduce((n, o) => n + BigInt(o.spend), 0n), used = walletBefore - await f.provider.getBalance(f.addresses[3]);
  assert.ok(used >= spent && used < spent + parseEther('0.05'), 'the wallet paid the orders plus gas, nothing else');
  const cycle = k.db.prepare('SELECT * FROM flywheel_cycles').get();
  assert.equal(cycle.status, 'done'); assert.equal(cycle.budget, String(parseEther('1')));
  const s = k.summary();
  assert.equal(s.chains[0].orders, 3); assert.equal(s.recent.length, 3); assert.match(s.recent[0].burnTx, /^0x[0-9a-f]{64}$/);
  // The next tick within the cadence does nothing.
  await k.tick(); assert.equal(k.db.prepare('SELECT COUNT(*) AS n FROM flywheel_cycles').get().n, 1);
});

test('a pool order waits while the price is away from its average; the curve orders still run', async t => {
  const { f, b, worker } = await market(t);
  const router = new Contract(f.dex.router.target, routerAbi(2), f.provider), deadline = (await f.now()) + 600;
  await mined(router.connect(f.signers[1]).multicall(deadline, [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn: f.dex.weth.target, tokenOut: b.token.target, fee: 10000, recipient: f.addresses[1], amountIn: parseEther('3'), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])], { value: parseEther('3') }));
  const now = (await f.provider.getBlock('latest')).timestamp * 1000;
  const k = new FlywheelKeeper({ workers: [worker], maxPerCycle: parseEther('1'), gasReserve: parseEther('0.01'), now: () => now });
  t.after(() => k.close());
  const deadBefore = await b.token.balanceOf(DEAD);
  await k.runCycle(worker);
  const rows = k.db.prepare('SELECT symbol, status, error FROM flywheel_orders ORDER BY rank').all().map(r => ({ ...r }));
  assert.equal(rows[0].symbol, 'BBB'); assert.equal(rows[0].status, 'skipped');
  assert.match(rows[0].error, /^(price_unsettled|price_history_short)$/, 'a moved pool, or one with no settled history, waits');
  const [, , , , next] = await new Contract(await b.curve.pool(), ['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)'], f.provider).slot0();
  assert.equal(Number(next), 16, 'the keeper asked the pool to keep more price history');
  assert.deepEqual(rows.slice(1).map(r => r.status), ['burned', 'burned']);
  assert.equal(await b.token.balanceOf(DEAD), deadBefore, 'nothing bought on the moved pool');
  assert.equal(k.summary().chains[0].orders, 2, 'only burned orders count as spent');
});

test('tokens left by an interrupted order are sent to the dead address at the next cycle; no budget means no orders', async t => {
  const { f, a, worker } = await market(t);
  let now = (await f.provider.getBlock('latest')).timestamp * 1000;
  const k = new FlywheelKeeper({ workers: [worker], maxPerCycle: parseEther('1'), gasReserve: parseEther('100000'), now: () => now });
  t.after(() => k.close());
  // A crash after the buy: the journal says 'sending' and the wallet holds the tokens.
  await mined(a.curve.connect(f.signers[3]).buy(parseEther('0.05'), 0, { value: parseEther('0.05') }));
  const held = await a.token.balanceOf(f.addresses[3]);
  k.db.prepare("INSERT INTO flywheel_orders(cycle, chain, rank, token, symbol, venue, market_cap, spend, status, at) VALUES(0,'local',1,?, 'AAA', 'curve', '1', '50000000000000000', 'sending', 0)").run(a.token.target);
  const deadBefore = await a.token.balanceOf(DEAD);
  await k.runCycle(worker);
  assert.equal(await a.token.balanceOf(DEAD) - deadBefore, held, 'recovered and sent to the dead address');
  const recovered = k.db.prepare('SELECT status, bought FROM flywheel_orders WHERE cycle=0').get();
  assert.deepEqual({ ...recovered }, { status: 'burned', bought: String(held) });
  // The gas reserve is larger than the wallet: nothing to spend.
  assert.equal(k.db.prepare('SELECT status FROM flywheel_cycles').get().status, 'no_budget');
  assert.equal(k.db.prepare("SELECT COUNT(*) AS n FROM flywheel_orders WHERE cycle>0").get().n, 0);
  // An empty cycle does not hold the wallet for a day: within the hour nothing runs, after it the cycle is retried.
  const cycles = () => k.db.prepare('SELECT COUNT(*) AS n FROM flywheel_cycles').get().n;
  now += 30 * 60_000; await k.tick(); assert.equal(cycles(), 1);
  now += 31 * 60_000; await k.tick(); assert.equal(cycles(), 2, 'retried after an hour');
});

test('index amounts with more than 18 decimals still rank (live listings carry 24-decimal market caps)', async () => {
  const listing = { address: '0x' + '1'.repeat(40), symbol: 'AKAZA', pair: 'native', graduated: true, complete: true, pool: '0x' + '2'.repeat(40), curve: '0x' + '3'.repeat(40),
    created: 1792967176000, circulatingMarketCapQuote: '0.162257321671398521848335', remainingBuy: '0', reserve: '0.051310270352021586' };
  const worker = evmFlywheelWorker({ chain: 'local', chainId: 31337, signer: { provider: {} }, listings: async () => [listing], dex: {} });
  const [t] = await worker.tokens();
  assert.equal(t.marketCap, 162257321671398521n, 'truncated to 18 decimals, not 0');
  assert.equal(t.poolReserve, 51310270352021586n);
  const plan = planFlywheelCycle({ chain: 'local', budget: parseEther('0.045'), tokens: [t], now: Math.floor(1792967176 + 2 * DAY) });
  assert.equal(plan.orders.length, 1, 'eligible: a native, graduated, two-day-old token with a pool');
  assert.equal(plan.orders[0].spend, 51310270352021586n * 50n / 10_000n, '0.5% of the pool');
});

test('configuration: off without a key; refuses mainnets and a Railway service without a volume', () => {
  assert.deepEqual(configuredFlywheelKeeper({ env: {}, publicIndex: null, dexes: {} }).summary(), { enabled: false, state: 'not_configured' });
  assert.throws(() => configuredFlywheelKeeper({ env: { ELPIDA_FLYWHEEL_EVM_KEY: '0x' + '11'.repeat(32), RAILWAY_ENVIRONMENT_ID: 'x' }, publicIndex: null, dexes: {}, path: '/tmp/x' }), /persistent Railway volume/);
  for (const id of [1, 56, 8453, 4663]) assert.equal(FLYWHEEL_EVM_CHAINS.has(id), false);
  assert.throws(() => evmFlywheelWorker({ chain: 'base', chainId: 8453, signer: {}, listings: async () => [], dex: {} }), /not an allowed testnet/);
});
