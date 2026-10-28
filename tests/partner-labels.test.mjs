// Early-partner labels (docs/DESIGN_PARTNER_TIERS.md section 3): the Explore badge, the token-page tag and safety line,
// and the launch-page tier notice, from the token record (`buybackBps`, `burned`) and the wallet's registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerOf, partnerChip, partnerCheck, launchTierNotice, TIERS } from '../apps/web/partner-labels.mjs';
import { safetyChecks } from '../apps/web/token-insights.mjs';

test('only the two tiers the contracts set are labelled; standard and unknown values are not', () => {
  assert.deepEqual(TIERS, { 1000: 'Partner', 2000: 'Elite' });
  for (const bps of [undefined, null, 0, 500, 1500, 3000, '2000x']) assert.equal(partnerOf({ buybackBps: bps }), null, String(bps));
  assert.deepEqual(partnerOf({ buybackBps: 1000, burned: '0' }), { bps: 1000, tier: 'Partner', percent: 10, burned: 0, burnedText: '0' });
  assert.equal(partnerOf({ buybackBps: '2000', burned: '1234567.5' }).tier, 'Elite', 'string bps from JSON');
});

test('the badge and safety line name the tier, the share and the tokens burned so far', () => {
  const chip = partnerChip({ symbol: 'SAITAMA', buybackBps: 2000, burned: '1836211.088561' });
  assert.deepEqual(chip, { tier: 'Elite', text: 'Burn 20%', title: 'Elite tier: 20% of trading fees buy back and burn $SAITAMA. 1.84M burned so far.' });
  assert.equal(partnerChip({ symbol: 'NEW', buybackBps: 1000 }).title, 'Partner tier: 10% of trading fees buy back and burn $NEW.', 'nothing burned yet');
  assert.equal(partnerChip({ symbol: 'STD', buybackBps: 0 }), null);
  for (const [burned, text] of [['999', '999'], ['12500', '12.5K'], ['3400000000', '3.40B'], ['0.4', '<1']]) assert.equal(partnerOf({ buybackBps: 1000, burned }).burnedText, text);
  assert.deepEqual(partnerCheck({ symbol: 'X', buybackBps: 1000, burned: '2500' }), { ok: true, text: 'Partner tier: 10% of trading fees buy back and burn $X, for life (2.5K burned so far).' });
  // The token page's safety list includes it for partner tokens only.
  const lines = token => safetyChecks(token).map(c => c.text);
  assert.ok(lines({ symbol: 'X', buybackBps: 2000, burned: '10' }).some(t => t.startsWith('Elite tier: 20%')));
  assert.ok(!lines({ symbol: 'Y', buybackBps: 0 }).some(t => /tier/.test(t)));
});

test('the launch page says what a registered wallet\'s next launch gets, and when a tier has ended', () => {
  const now = 1_800_000_000;
  assert.equal(launchTierNotice(null, now), null);
  assert.equal(launchTierNotice({ buybackBps: 0, expiresAt: 0 }, now), null, 'no tier');
  const live = launchTierNotice({ buybackBps: 2000, expiresAt: now + 30 * 86400 }, now);
  assert.equal(live.live, true); assert.equal(live.tier, 'Elite'); assert.equal(live.percent, 20);
  assert.match(live.text, /^Elite tier: 20% of this token's trading fees will buy back and burn it, for life, out of Elpida's share\. You still keep 50%\. Applies to launches until /);
  const ended = launchTierNotice({ buybackBps: 1000, expiresAt: now - 1 }, now);
  assert.equal(ended.live, false);
  assert.match(ended.text, /^Your Partner tier ended on .+\. Tokens you launch now are standard \(50\/50\)\.$/);
});
