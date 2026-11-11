// Creator rewards fixes (Malik, 11 November): a wallet + X allocation of 50/50 was refused with "Every allocation share
// must be above zero" (the launch form read `percent`, which the normalized policy no longer carries); holder strategies
// take a USD threshold ($20 by default) and a USD minimum holding the keeper applies at each distribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/browser-modules.mjs';
import { normalizeRewardPolicy, recipientBps } from '../apps/web/reward-policy.mjs';

const { identityTerms, creatorSplitTerms } = await import('../apps/web/v2-launchpad.mjs');
const me = '0x' + '11'.repeat(20);

test('allocation shares survive normalization: a wallet + X account at 50/50 launches', () => {
  const policy = normalizeRewardPolicy({ mode: 'exclusive', chain: 'robinhood-testnet', recipients: [{ kind: 'wallet', target: '', percent: '50' }, { kind: 'x', target: 'ulquimakesmagic', percent: '50' }] });
  const rows = policy.recipients.map(r => ({ kind: r.kind, target: r.target, bps: recipientBps(r) }));
  assert.deepEqual(rows.map(r => r.bps), [5000, 5000]);
  const terms = identityTerms(rows, me);
  assert.deepEqual(terms.map(r => [r.label, r.bps]), [['wallet', 5000], ['x:ulquimakesmagic', 5000]]);
  // Wallet-only splits had the same bug.
  const split = normalizeRewardPolicy({ mode: 'creator', chain: 'base-sepolia', recipients: [{ kind: 'wallet', target: '', percent: '70' }, { kind: 'wallet', target: '0x' + '22'.repeat(20), percent: '30' }] });
  assert.deepEqual(creatorSplitTerms(split.recipients.map((r, i) => ({ wallet: r.target || (i === 0 ? me : ''), bps: recipientBps(r) }))).shares, [7000, 3000]);
  assert.equal(recipientBps({ percent: '12.5' }), 1250);
});
