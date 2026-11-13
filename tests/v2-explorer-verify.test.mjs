// Explorer source verification for a V2 deployment (scripts/v2-explorer-verify.mjs): the submitted Standard JSON input
// is self-contained and rebuilds the deployed bytecode, the constructor arguments come from the creation transactions
// (including the hook's CREATE2 call), a Windows (CRLF) build is recognised, and the API key never appears in output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, Wallet } from 'ethers';
import { standardInput, buildBytecode, explorerJobs, submit, verifyOnExplorer, compilerVersion, CONTRACTS } from '../scripts/v2-explorer-verify.mjs';
import { artifacts } from '../scripts/v2-mainnet-deploy.mjs';

const art = artifacts(), enc = (types, values) => AbiCoder.defaultAbiCoder().encode(types, values).slice(2);
const addr = () => Wallet.createRandom().address;

test('the Standard JSON input is self-contained, uses the build settings and rebuilds the same bytecode', () => {
  const input = standardInput(CONTRACTS.airdrop);
  assert.ok(input.sources['contracts/evm/v2/ElpidaV2Distributor.sol']);
  assert.equal(input.settings.viaIR, true); assert.equal(input.settings.evmVersion, 'cancun'); assert.deepEqual(input.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(buildBytecode(CONTRACTS.airdrop, 'disk'), art.distributor.bytecode.replace(/^0x/, '').toLowerCase(), 'no import callback needed, same bytecode');
  const crlf = standardInput(CONTRACTS.router, { eol: 'crlf' });
  for (const [key, s] of Object.entries(crlf.sources)) assert.equal(/(?<!\r)\n/.test(s.content), key.startsWith('@'), `${key}: only repository files follow the checkout`);
  assert.match(compilerVersion(), /^v0\.8\.26\+commit\.[0-9a-f]{8}$/);
});

test('jobs: constructor arguments from the creation transactions, the hook through CREATE2, a CRLF build recognised, a foreign build refused', async () => {
  const factoryArgs = enc(['address', 'uint256', 'bool'], [addr(), 20_000, true]);
  const hookArgs = enc(['address', 'address', 'address', 'address', 'address', 'address', 'uint256'], [addr(), addr(), addr(), addr(), addr(), addr(), 100]);
  const dropArgs = enc(['address', 'uint256', 'uint256', 'string', 'address', 'address', 'address'], [addr(), 0, 1_793_491_200, 'trader-airdrop', addr(), addr(), addr()]);
  const crlfDrop = buildBytecode(CONTRACTS.airdrop, 'crlf');
  assert.notEqual(crlfDrop, art.distributor.bytecode.replace(/^0x/, '').toLowerCase(), 'line endings change the metadata hash');
  const txs = {
    '0xf': art.factory.bytecode + factoryArgs,
    '0xh': new Interface(['function deploy(bytes,bytes32) returns(address)']).encodeFunctionData('deploy', [art.hook.bytecode + hookArgs, '0x' + '00'.repeat(31) + '12']),
    '0xa': '0x' + crlfDrop + dropArgs,
    '0xr': '0x6080' + 'ab'.repeat(40),
  };
  const provider = { getTransaction: async h => (txs[h] ? { data: txs[h] } : null) };
  const record = { contracts: { factory: addr(), hook: addr(), airdrop: addr(), router: addr(), holder: addr(), flywheel: addr() },
    txs: { factory: { hash: '0xf' }, hook: { hash: '0xh' }, airdrop: { hash: '0xa' }, router: { hash: '0xr' }, holder: { hash: '0xmissing' } } };
  const jobs = Object.fromEntries((await explorerJobs({ provider, record, art })).map(j => [j.key, j]));
  assert.deepEqual([jobs.factory.ok, jobs.factory.eol, jobs.factory.args], [true, 'disk', factoryArgs]);
  assert.deepEqual([jobs.hook.ok, jobs.hook.args], [true, hookArgs], 'the hook\'s arguments come out of the CREATE2 call');
  assert.deepEqual([jobs.airdrop.ok, jobs.airdrop.eol, jobs.airdrop.args], [true, 'crlf', dropArgs], 'a Windows build is matched and its sources submitted with CRLF');
  assert.equal(jobs.router.ok, false); assert.match(jobs.router.detail, /gitCommit/);
  assert.match(jobs.holder.detail, /not found/); assert.match(jobs.flywheel.detail, /no creation transaction/);
  assert.equal(jobs.create2, undefined, 'no address, no job');
});

const KEY = 'SECRETAPIKEY123';
function explorer(script) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const params = Object.fromEntries(new URLSearchParams(opts.body ?? url.split('?')[1]));
    calls.push({ url, params, post: opts.method === 'POST' });
    const reply = script(params, calls.length);
    return { ok: reply !== 500, status: reply === 500 ? 500 : 200, json: async () => reply };
  };
  return { fetch, calls };
}
const job = { key: 'airdrop', address: '0x19e98b21FC07315D4f621A662688c6D3Da2570C0', contractName: CONTRACTS.airdrop, args: 'ab', eol: 'crlf' };
const sleep = async () => {};

test('submit: skips a verified contract, waits through the queue, reports a failure, never leaks the key', async () => {
  let e = explorer(p => (p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: 'pragma solidity' }] } : assert.fail('nothing submitted')));
  assert.deepEqual(await submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job }), { ok: true, detail: 'already verified' });

  e = explorer((p, n) => p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: '' }] }
    : p.action === 'verifysourcecode' ? { status: '1', result: 'guid-1' }
    : { status: n < 5 ? '0' : '1', result: n < 5 ? 'Pending in queue' : 'Pass - Verified' });
  assert.deepEqual(await submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job }), { ok: true, detail: 'verified' });
  const sent = e.calls.find(c => c.params.action === 'verifysourcecode');
  assert.ok(sent.post && sent.url.endsWith('chainid=84532') && !sent.url.includes(KEY), 'the key goes in the POST body, not the URL');
  assert.equal(sent.params.contractname, CONTRACTS.airdrop); assert.equal(sent.params.constructorArguements, 'ab'); assert.equal(sent.params.codeformat, 'solidity-standard-json-input');
  assert.ok(JSON.parse(sent.params.sourceCode).sources['contracts/evm/v2/ElpidaV2Distributor.sol'].content.includes('\r\n'), 'CRLF sources for a CRLF build');

  e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{}] } : p.action === 'verifysourcecode' ? { status: '1', result: 'g' } : { status: '0', result: 'Fail - Unable to verify. Compiled contract deployment bytecode does NOT match' });
  const fail = await submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job });
  assert.equal(fail.ok, false); assert.match(fail.detail, /does NOT match/); assert.ok(!fail.detail.includes(KEY));

  e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{}] } : { status: '0', message: 'NOTOK', result: 'Contract source code already verified' });
  assert.deepEqual(await submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job }), { ok: true, detail: 'already verified' });

  e = explorer(p => p.action === 'getsourcecode' ? { status: '1', result: [{}] } : p.action === 'verifysourcecode' ? { status: '1', result: 'g' } : { status: '0', result: 'Pending in queue' });
  assert.match((await submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job, polls: 3 })).detail, /run this again/);

  e = explorer(() => 500);
  await assert.rejects(submit({ fetch: e.fetch, sleep, chainId: 84532, apiKey: KEY, job }), err => /HTTP 500/.test(err.message) && !err.message.includes(KEY));
});

test('verifyOnExplorer refuses the wrong chain or an unknown explorer, and reports each contract with its explorer link', async () => {
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getTransaction: async () => ({ data: art.factory.bytecode + enc(['address', 'uint256', 'bool'], [addr(), 20_000, true]) }) };
  const record = { contracts: { factory: '0x167bff77A4Ed0054784186B89Cf8A33D83e2213D' }, txs: { factory: { hash: '0x1' } } };
  await assert.rejects(verifyOnExplorer({ provider, plan: { chainId: 84532 }, record, apiKey: KEY }), /RPC is chain 8453/);
  await assert.rejects(verifyOnExplorer({ provider, plan: { chainId: 999 }, record, apiKey: KEY }), /No explorer/);
  const e = explorer(p => (p.action === 'getsourcecode' ? { status: '1', result: [{ SourceCode: 'x' }] } : assert.fail()));
  const out = await verifyOnExplorer({ provider, plan: { chainId: 8453 }, record, apiKey: KEY, fetch: e.fetch, sleep });
  assert.deepEqual(out, [{ check: 'factory', ok: true, detail: 'already verified: https://basescan.org/address/0x167bff77A4Ed0054784186B89Cf8A33D83e2213D#code' }]);
});
