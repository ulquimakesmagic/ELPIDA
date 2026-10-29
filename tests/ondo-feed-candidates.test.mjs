import test from 'node:test';
import assert from 'node:assert/strict';
import { ethereumOndoFeedCandidates } from '../scripts/ondo-feed-candidates.mjs';
const asset = { network: 'ethereum', provider: 'ondo', symbol: 'TSLAon', address: '0x' + '12'.repeat(20) };
const record = path => ({ name: 'TSLAon ' + path, path, proxyAddress: '0x' + '34'.repeat(20), docs: { blockchainName: 'Ethereum', baseAsset: 'TSLAon', quoteAsset: 'USD', productTypeCode: 'primaryTokenizedPrice' } });
test('discovery retains competing API/calculated candidates without choosing or approving one', () => {
  const result = ethereumOndoFeedCandidates([record('api'), record('calculated')], [asset]);
  assert.equal(result[0].candidates.length, 2);
  assert.ok(result[0].candidates.every(c => !c.semanticsVerified && !c.statusSourceVerified && !c.liveCapabilitiesApproved));
});
test('underlying ticker, wrong chain/provider/quote and malformed address cannot become canonical candidates', () => {
  const records = ['wrongChain', 'underlying', 'badQuote', 'badAddress'].map(k => {
    const r = record(k);
    if (k === 'wrongChain') r.docs.blockchainName = 'Base';
    if (k === 'underlying') r.docs.baseAsset = 'TSLA';
    if (k === 'badQuote') r.docs.quoteAsset = 'ETH';
    if (k === 'badAddress') r.proxyAddress = 'invalid';
    return r;
  });
  const result = ethereumOndoFeedCandidates(records, [asset, { ...asset, network: 'bnb' }, { ...asset, provider: 'xstocks' }]);
  assert.equal(result.length, 1); assert.deepEqual(result[0].candidates, []); assert.equal(result[0].liveCapabilitiesApproved, false);
});
