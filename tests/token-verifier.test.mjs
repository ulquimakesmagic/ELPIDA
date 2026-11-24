// Per-token explorer verification (apps/api/token-verifier.mjs; Malik, 22 November 2026): a token launched by the V2
// factory matches the ElpidaV2Token build, its constructor arguments are rebuilt from the token and the hook, the
// explorer gets the right submission, done tokens are not sent again, failures are retried a few times, and a
// foreign contract is never submitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import { v2Fixture, launchV2 } from './helpers/v2-fixture.mjs';
import { TokenVerifier, tokenArgs, tokenRuntime, TOKEN_CONTRACT, TOKEN_SUPPLY } from '../apps/api/token-verifier.mjs';

const sleep = async () => {};
function explorer(script) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const params = Object.fromEntries(new URLSearchParams(opts.body ?? url.split('?')[1]));
    calls.push(params);
    return { ok: true, status: 200, json: async () => script(params) };
  };
  return { fetch, calls };
}
const memory = () => { const m = new Map(); return { get: (k, f) => (m.has(k) ? m.get(k) : f), set: (k, v) => m.set(k, v), m }; };

test('a launched token is recognised, submitted with its constructor arguments, and not sent twice', async t => {
  const f = await v2Fixture(t);
  const { token } = await launchV2(f, { name: 'Hope', symbol: 'HOPE' });
  const code = (await f.provider.getCode(token.target ?? token)).toLowerCase();
  assert.equal(code, tokenRuntime('lf'), 'the factory-made token is exactly the LF build (no immutables)');
  assert.notEqual(tokenRuntime('crlf'), code, 'a CRLF build differs (metadata hash)');
  const address = token.target ?? token;
  let verified = false;
  const e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: verified ? 'x' : '' }] }
    : p.action === 'verifysourcecode' ? { status: '1', result: 'guid' } : (verified = true, { status: '1', result: 'Pass - Verified' }));
  const state = memory(), v = new TokenVerifier({ apiKey: 'K', fetch: e.fetch, sleep });
  const r = await v.run({ chainId: 8453, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state, now: 1000 });
  assert.deepEqual(r.submitted.map(x => [x.ok, x.detail]), [[true, 'verified']]);
  const sent = e.calls.find(c => c.action === 'verifysourcecode');
  assert.equal(sent.contractname, TOKEN_CONTRACT);
  assert.equal(sent.constructorArguements, AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint256', 'address'], ['Hope', 'HOPE', TOKEN_SUPPLY, f.hook.target]).slice(2));
  assert.equal(sent.constructorArguements, tokenArgs('Hope', 'HOPE', f.hook.target));
  const again = await v.run({ chainId: 8453, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state, now: 999_999 });
  assert.equal(again.submitted.length, 0, 'a verified token is done');
});

test('a contract that is not an Elpida token is never submitted; failures retry, then stop', async () => {
  const e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{}] } : p.action === 'verifysourcecode' ? { status: '0', result: 'Unable to locate ContractCode' } : assert.fail());
  const state = memory(), v = new TokenVerifier({ apiKey: 'K', fetch: e.fetch, sleep, runtime: eol => `0x${eol}`, retryAfter: 100, maxAttempts: 2 });
  const foreign = { getCode: async () => '0xdead' };
  const a = '0x1111111111111111111111111111111111111111';
  let r = await v.run({ chainId: 56, provider: foreign, hook: a, tokens: [{ address: a }], state, now: 0 });
  assert.match(r.submitted[0].detail, /not an ElpidaV2Token/);
  assert.equal(e.calls.filter(c => c.action === 'verifysourcecode').length, 0);
  assert.equal((await v.run({ chainId: 56, provider: foreign, hook: a, tokens: [{ address: a }], state, now: 10_000 })).submitted.length, 0, 'given up on at once');

  const ours = { getCode: async () => '0xcrlf', call: async () => { throw new Error('no node'); } };
  const b = '0x2222222222222222222222222222222222222222';
  r = await v.run({ chainId: 56, provider: ours, hook: a, tokens: [{ address: b }], state, now: 0 });
  assert.equal(r.submitted[0].ok, false);
  assert.equal((await v.run({ chainId: 56, provider: ours, hook: a, tokens: [{ address: b }], state, now: 50 })).submitted.length, 0, 'waits before retrying');
  assert.equal((await v.run({ chainId: 56, provider: ours, hook: a, tokens: [{ address: b }], state, now: 200 })).submitted.length, 1, 'retried');
  assert.equal((await v.run({ chainId: 56, provider: ours, hook: a, tokens: [{ address: b }], state, now: 400 })).submitted.length, 0, 'stops after maxAttempts');
});

test('a few tokens per run', async () => {
  const e = explorer(() => ({ status: '1', result: [{ SourceCode: 'x' }] }));
  const v = new TokenVerifier({ apiKey: 'K', fetch: e.fetch, sleep, perTick: 2 }), state = memory();
  const tokens = ['0x' + '3'.repeat(40), '0x' + '4'.repeat(40), '0x' + '5'.repeat(40)].map(address => ({ address }));
  const r = await v.run({ chainId: 8453, provider: {}, hook: tokens[0].address, tokens, state, now: 0 });
  assert.equal(r.submitted.length, 2); assert.equal(r.pending, 1);
});

test('an address typed with the wrong capitals is accepted (22 Nov: a bad checksum stopped verify-token)', async () => {
  const e = explorer(() => ({ status: '1', result: [{ SourceCode: 'x' }] }));
  const v = new TokenVerifier({ apiKey: 'K', fetch: e.fetch, sleep });
  const r = await v.run({ chainId: 56, provider: {}, hook: '0x' + '1'.repeat(40), tokens: [{ address: '0xEEcA39F2aF81296De89685e6dDdA58acD5BA1053' }], state: memory(), now: 0 });
  assert.equal(r.submitted[0].ok, true);
  assert.equal(r.submitted[0].address.toLowerCase(), '0xeeca39f2af81296de89685e6ddda58acd5ba1053');
});

test('Robinhood Chain (Blockscout) tokens are verified keyless or with a Blockscout key, never with the Etherscan key', async t => {
  const f = await v2Fixture(t);
  const { token } = await launchV2(f, { name: 'Hood', symbol: 'HOOD' });
  const address = token.target ?? token;
  const urls = [], keys = [];
  let verified = false;
  const fetch = async (url, opts = {}) => {
    urls.push(url); const p = Object.fromEntries(new URLSearchParams(opts.body ?? url.split('?')[1])); keys.push(p.apikey ?? '');
    const body = p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: verified ? 'x' : '' }] }
      : p.action === 'verifysourcecode' ? { status: '1', result: 'guid' } : (verified = true, { status: '1', result: 'Pass - Verified' });
    return { ok: true, status: 200, json: async () => body };
  };
  // Etherscan key only: Robinhood goes keyless to the explorer's own API, two tokens per run.
  const v = new TokenVerifier({ apiKey: 'ETHERSCAN', fetch, sleep });
  assert.equal(v.supports(4663), true);
  const r = await v.run({ chainId: 4663, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state: memory(), now: 1 });
  assert.deepEqual(r.submitted.map(x => x.ok), [true]);
  assert.ok(urls.every(u => u.startsWith('https://robinhoodchain.blockscout.com/api')), urls[0]);
  assert.ok(keys.every(k => k !== 'ETHERSCAN'));
  // A Blockscout PRO key goes to Blockscout's PRO API.
  urls.length = 0; verified = false;
  const pro = new TokenVerifier({ blockscoutKey: 'proapi_x', fetch, sleep });
  await pro.run({ chainId: 4663, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state: memory(), now: 1 });
  assert.ok(urls.every(u => u.startsWith('https://api.blockscout.com/v2/api?chainid=4663')), urls[0]);
  // Without an Etherscan key, Etherscan chains are skipped and nothing is sent.
  assert.equal(pro.supports(8453), false);
  urls.length = 0;
  assert.deepEqual(await pro.run({ chainId: 8453, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state: memory(), now: 1 }), { submitted: [], pending: 0 });
  assert.equal(urls.length, 0);
});

test('a token the explorer has not indexed yet is retried after 2 minutes, then on the long interval', async t => {
  const f = await v2Fixture(t);
  const { token } = await launchV2(f, { name: 'Soon', symbol: 'SOON' });
  const address = token.target ?? token;
  let fail = true;
  const e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: '' }] }
    : p.action === 'verifysourcecode' ? (fail ? { status: '0', result: 'Unable to locate ContractCode' } : { status: '1', result: 'guid' }) : { status: '1', result: 'Pass - Verified' });
  const state = memory(), v = new TokenVerifier({ apiKey: 'K', fetch: e.fetch, sleep });
  const go = now => v.run({ chainId: 8453, provider: f.provider, hook: f.hook.target, tokens: [{ address }], state, now });
  assert.deepEqual((await go(1000)).submitted.map(x => x.ok), [false]);
  assert.equal((await go(1100)).submitted.length, 0, 'not before 2 minutes');
  assert.deepEqual((await go(1120)).submitted.map(x => x.ok), [false], 'second try at 2 minutes');
  assert.deepEqual((await go(1240)).submitted.map(x => x.ok), [false], 'third try 2 minutes later');
  assert.equal((await go(1400)).submitted.length, 0, 'after that, the long interval');
  fail = false;
  assert.deepEqual((await go(1240 + 6 * 3600)).submitted.map(x => x.ok), [true]);
});
