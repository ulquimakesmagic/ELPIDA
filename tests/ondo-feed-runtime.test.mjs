import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareDualAggregatorRuntime } from '../scripts/lib/ondo-feed-runtime.mjs';
const reference = JSON.parse(readFileSync(new URL('./fixtures/dual-aggregator-runtime.json', import.meta.url), 'utf8')).runtime;
const edit = (code, offsets) => {
  const bytes = Buffer.from(code.slice(2), 'hex');
  for (const offset of offsets) bytes[offset] ^= 1;
  return '0x' + bytes.toString('hex');
};
test('verified reference family can match without approving feed methodology or live use', () => {
  const same = compareDualAggregatorRuntime(reference, reference);
  assert.equal(same.matchesReferenceFamily, true); assert.equal(same.semanticsVerified, false); assert.equal(same.liveCapabilitiesApproved, false);
  // A different deployment can instantiate another value in one declared immutable group.
  const variant = edit(reference, [921 + 31, 8340 + 31, 17855 + 31]);
  assert.equal(compareDualAggregatorRuntime(reference, variant).matchesReferenceFamily, true);
});
test('opcode/metadata/length changes and inconsistent immutable occurrences cannot be masked away', () => {
  for (const candidate of [edit(reference, [0]), edit(reference, [23180]), edit(reference, [921 + 31]), reference.slice(0, -2)]) {
    assert.equal(compareDualAggregatorRuntime(reference, candidate).matchesReferenceFamily, false);
  }
});
test('unreviewed reference or malformed bytecode cannot anchor a comparison', () => {
  assert.throws(() => compareDualAggregatorRuntime(edit(reference, [0]), reference));
  for (const malformed of ['0x', '0x123', '0xzz']) assert.throws(() => compareDualAggregatorRuntime(reference, malformed));
});
