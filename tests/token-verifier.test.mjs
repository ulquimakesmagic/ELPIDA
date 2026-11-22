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
