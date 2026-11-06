// Model 11 phase 4: the router the site trades through (a v4 launch has no curve contract). Exact-input buys and
// sells for ETH and USDC pairs, the revert-based quote matching the real trade to the wei, and the Swapped event that
// names the real trader. Local cancun chain with Uniswap's own PoolManager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, parseEther, ZeroAddress } from 'ethers';
import { v4Fixture, v4Art, launchV4, mined, parse, delta } from './helpers/v4-fixture.mjs';

const FAR = 2n ** 40n;
async function withRouter(t, options) {
  const f = await v4Fixture(t, options), a = v4Art('ElpidaV4Router');
  f.v4router = await f.deploy(a, f.manager.target, f.hook.target);
  return f;
}
const routerAs = (f, signer) => f.v4router.connect(signer);
/** Matches a revert with the router's custom error `name` (ethers leaves estimateGas reverts undecoded). */
const custom = (f, name) => err => err.revert?.name === name || String(err.data ?? err.info?.error?.data ?? '').startsWith(f.v4router.interface.getError(name).selector);

test('Model 11 router: a native buy and sell match the quote exactly and name the real trader', async t => {
  const f = await withRouter(t), l = await launchV4(f), buyer = f.signers[1], who = f.addresses[1];
  await f.advance(120); // past the anti-snipe window: base fee
  const input = parseEther('0.1');
  const [paid, expected] = await f.v4router.quote.staticCall(l.token.target, true, input);
  assert.equal(paid, input);
  const bought = await delta(f, l, who, () => mined(routerAs(f, buyer).buy(l.token.target, input, expected, who, FAR, { value: input })));
  assert.equal(bought.token, expected, 'the quote is the trade');
  assert.equal(bought.eth, -input);
  const [swapped] = parse(f.v4router, bought.receipt, 'Swapped');
  assert.equal(swapped.args.trader, who); assert.equal(swapped.args.recipient, who); assert.equal(swapped.args.buy, true);
  assert.equal(swapped.args.quoteAmount, input); assert.equal(swapped.args.tokenAmount, expected);
  const [fee] = parse(f.hook, bought.receipt, 'Fee');
  assert.equal(fee.args.trader, f.v4router.target, 'the hook only sees the router: the indexer reads Swapped');
  assert.equal(fee.args.fee, input * 125n / 10000n);

  const tokens = expected / 2n;
  const [, quoteOut] = await f.v4router.quote.staticCall(l.token.target, false, tokens);
  await mined(l.token.connect(buyer).approve(f.v4router.target, tokens));
  const sold = await delta(f, l, who, () => mined(routerAs(f, buyer).sell(l.token.target, tokens, quoteOut, who, FAR)));
  assert.equal(sold.token, -tokens); assert.equal(sold.eth, quoteOut);
  assert.ok(quoteOut < input / 2n, 'a round trip pays the fee twice');
  assert.equal(await f.provider.getBalance(f.v4router.target), 0n, 'the router holds nothing');
});

test('Model 11 router: USDC pairs pull the quote with a plain approval; slippage, deadlines and value are checked', async t => {
  const f = await withRouter(t), l = await launchV4(f, { usdc: true }), buyer = f.signers[1], who = f.addresses[1];
  const input = 25n * 10n ** 6n;
  const [, expected] = await f.v4router.quote.staticCall(l.token.target, true, input);
  await assert.rejects(routerAs(f, buyer).buy(l.token.target, input, expected, who, FAR), /payment|allowance|ERC20/i, 'no approval, no trade');
  await mined(f.usdc.connect(buyer).approve(f.v4router.target, input));
  await assert.rejects(routerAs(f, buyer).buy(l.token.target, input, expected, who, FAR, { value: 1n }), /value/);
  await assert.rejects(routerAs(f, buyer).buy(l.token.target, input, expected * 2n, who, FAR), custom(f, 'Slippage'));
  await assert.rejects(routerAs(f, buyer).buy(l.token.target, input, 0n, who, 1n), custom(f, 'Expired'));
  const bought = await delta(f, l, who, () => mined(routerAs(f, buyer).buy(l.token.target, input, expected, who, FAR)));
  assert.ok(bought.token > 0n && bought.token >= expected * 99n / 100n, 'anti-snipe fee may tick down between quote and trade');
  assert.equal(bought.eth, -input);
  await mined(l.token.connect(buyer).approve(f.v4router.target, bought.token));
  const [, back] = await f.v4router.quote.staticCall(l.token.target, false, bought.token);
  const sold = await delta(f, l, who, () => mined(routerAs(f, buyer).sell(l.token.target, bought.token, back, who, FAR)));
  assert.ok(sold.eth >= back, 'at least the quote (the anti-snipe fee only falls)');
  assert.equal(await f.usdc.balanceOf(f.v4router.target), 0n);
});

test('Model 11 router: a buy for someone else and an unknown token', async t => {
  const f = await withRouter(t), l = await launchV4(f), payer = f.signers[1], friend = f.addresses[3];
  const input = parseEther('0.01');
  const receipt = await mined(routerAs(f, payer).buy(l.token.target, input, 0n, friend, FAR, { value: input }));
  const [swapped] = parse(f.v4router, receipt, 'Swapped');
  assert.equal(swapped.args.trader, f.addresses[1]); assert.equal(swapped.args.recipient, friend);
  assert.equal(await l.token.balanceOf(friend), swapped.args.tokenAmount);
  const stranger = await f.deploy(v4Art('MockUSDC'));
  await assert.rejects(f.v4router.quote.staticCall(stranger.target, true, input), err => /NotLaunched/.test(err.message) || err.revert?.name === 'NotLaunched' || /revert/i.test(err.message));
  await assert.rejects(routerAs(f, payer).buy(ZeroAddress, input, 0n, friend, FAR, { value: input }));
  assert.equal(await new Contract(f.v4router.target, ['function ROUTER_VERSION() view returns(uint256)'], f.provider).ROUTER_VERSION(), 1n);
});

test('Model 11 router: the buy that reaches the milestone goes through and later trades pay the 1% pool fee', async t => {
  const f = await withRouter(t), l = await launchV4(f), whale = f.signers[4], who = f.addresses[4];
  await f.advance(120);
  const big = parseEther('30');
  const receipt = await mined(routerAs(f, whale).buy(l.token.target, big, 0n, who, FAR, { value: big }));
  assert.equal(parse(f.hook, receipt, 'Milestone').length, 1, 'milestone reached in the router trade');
  assert.equal(await f.hook.currentFeeBps(l.token.target), 100n);
  const input = parseEther('0.5'), [, out] = await f.v4router.quote.staticCall(l.token.target, true, input);
  const r2 = await mined(routerAs(f, whale).buy(l.token.target, input, out, who, FAR, { value: input }));
  const [fee] = parse(f.hook, r2, 'Fee');
  assert.equal(fee.args.feeBps, 100n); assert.equal(fee.args.fee, input / 100n);
});
