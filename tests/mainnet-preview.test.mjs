// One command per chain previews Elpida on forks of real mainnet state (scripts/mainnet-preview.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, summarize, CHAINS } from '../scripts/mainnet-preview.mjs';

test('every mainnet chain runs the native lifecycle; stock chains add each stock; Base and Model 11 are reported, not hidden', () => {
  const steps = plan([], { ELPIDA_EQUITY_FORK_RPC: 'https://eth.example', ELPIDA_EQUITY_FORK_RPC_BNB: 'https://bnb.example' });
  for (const chain of Object.keys(CHAINS)) assert.ok(steps.some(s => s.chain === chain && s.kind === 'native' && s.cmd[1] === CHAINS[chain].fork));
  const stocks = steps.filter(s => s.kind === 'stock');
  assert.deepEqual(stocks.filter(s => s.chain === 'ethereum' && !s.skip).map(s => s.symbol), ['TSLAon', 'SPYon', 'NVDAon']);
  assert.ok(stocks.filter(s => s.chain === 'bnb').every(s => !s.skip));
  assert.ok(stocks.filter(s => s.chain === 'robinhood').every(s => /ELPIDA_EQUITY_FORK_RPC_ROBINHOOD/.test(s.skip)), 'no archive RPC: skipped with the variable to set');
  assert.ok(steps.some(s => s.chain === 'base' && s.skip));
  assert.ok(steps.some(s => s.kind === 'model11' && s.skip));
});

test('chains and stocks can be narrowed; unknown chains are refused', () => {
  const steps = plan(['ethereum', '--stocks', 'TSLAon'], { ELPIDA_EQUITY_FORK_RPC: 'x' });
  assert.deepEqual(steps.filter(s => s.kind === 'stock').map(s => s.symbol), ['TSLAon']);
  assert.ok(steps.every(s => ['ethereum', 'all'].includes(s.chain)));
  assert.throws(() => plan(['solana']), /Unknown chain/);
});

test('a skipped step is never summarised as passed; a failed check is named', () => {
  assert.equal(summarize({ label: 'x', skip: 'No archive RPC' }, null, null).result, 'SKIPPED');
  const row = summarize({ label: 'y' }, { result: 'FAIL', checks: [{ name: 'a', ok: true }, { name: 'graduation', ok: false }] }, 1);
  assert.equal(row.result, 'FAIL'); assert.equal(row.detail, 'graduation');
  assert.equal(summarize({ label: 'z' }, null, 1).result, 'FAIL', 'a missing report with a failing exit is a failure');
});
