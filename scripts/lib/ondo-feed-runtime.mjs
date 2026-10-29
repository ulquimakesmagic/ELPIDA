import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';

// Sourcify v2: src/DualAggregator.sol, solc 0.8.24+commit.e11b9ed9.
// Immutable offsets are compiler output, not ranges inferred from candidate differences.
export const DUAL_REFERENCE = Object.freeze({
  address: '0xf1d388ca8f56a936cb758bc81175e1ad2ba85e18',
  codeHash: '0x8d2bf39f6bc925ed3c6b7a2276f9a3ac37ff0ad96285ae1f1d1f0614c1cb1155',
  source: 'https://sourcify.dev/server/v2/contract/1/0xf1d388ca8f56a936cb758bc81175e1ad2ba85e18?fields=all',
});
const groups = [[921, 8340, 17855], [1284, 8380, 17898], [12702], [15711, 16371], [1123]];
const bytes = hex => { assert.match(hex, /^0x(?:[0-9a-f]{2})+$/i); return Uint8Array.from(Buffer.from(hex.slice(2), 'hex')); };
const word = (code, offset) => Buffer.from(code.slice(offset, offset + 32)).toString('hex');

/** A fixed reference-family comparison, NOT feed methodology/status or deployment equality verification. */
export function compareDualAggregatorRuntime(referenceCode, candidateCode) {
  const reference = bytes(referenceCode), candidate = bytes(candidateCode);
  assert.equal(keccak256(reference), DUAL_REFERENCE.codeHash, 'source reference runtime must match reviewed hash');
  const reject = reason => ({ matchesReferenceFamily: false, semanticsVerified: false, liveCapabilitiesApproved: false, reason });
  if (candidate.length !== reference.length) return reject('Runtime length differs.');
  const immutableValues = [];
  for (const group of groups) {
    const value = word(candidate, group[0]);
    if (!group.every(offset => word(candidate, offset) === value)) return reject('Repeated immutable occurrences disagree.');
    immutableValues.push({ offsets: [...group], value: '0x' + value });
    for (const offset of group) { reference.fill(0, offset, offset + 32); candidate.fill(0, offset, offset + 32); }
  }
  // No opcode, metadata, or other region is masked. Only the five declared immutable groups above.
  if (keccak256(reference) !== keccak256(candidate)) return reject('Runtime differs outside compiler-declared immutable words.');
  return { matchesReferenceFamily: true, semanticsVerified: false, liveCapabilitiesApproved: false,
    normalizedCodeHash: keccak256(candidate), immutableValues,
    note: 'Reference implementation family matches outside consistent compiler-declared immutable fields, including metadata. Not an exact deployment match, offchain-report audit or corporate-action/status approval.' };
}
