// Early-partner labels (docs/DESIGN_PARTNER_TIERS.md): what a token's tier and burns look like on Explore cards, the
// token page and the launch page. Pure helpers, no DOM: the token record carries `buybackBps` (0, 1000 or 2000, fixed at
// launch) and `burned` (whole tokens burned so far by its buybacks, curve and LP fees together), and the launching
// wallet's registration is { buybackBps, expiresAt, live }.

export const TIERS = { 1000: 'Partner', 2000: 'Elite' };

const whole = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
const count = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? String(Math.floor(n)) : n > 0 ? '<1' : '0';

/** The tier a token launched with, or null for standard tokens (and any value the contracts would not set). */
export function partnerOf(token) {
  const bps = Number(token?.buybackBps);
  if (!TIERS[bps]) return null;
  const burned = whole(token.burned);
  return { bps, tier: TIERS[bps], percent: bps / 100, burned, burnedText: count(burned) };
}

/** Short chip text and its accessible title for a partner token; null otherwise. */
export function partnerChip(token) {
  const p = partnerOf(token);
  if (!p) return null;
  const symbol = token.symbol ? `$${token.symbol}` : 'the token';
  return {
    tier: p.tier, text: `Burn ${p.percent}%`,
    title: `${p.tier} tier: ${p.percent}% of trading fees buy back and burn ${symbol}${p.burned ? `. ${p.burnedText} burned so far.` : '.'}`,
  };
}

/** The safety-checklist line for a partner token; null otherwise. */
export function partnerCheck(token) {
  const p = partnerOf(token);
  if (!p) return null;
  const symbol = token.symbol ? `$${token.symbol}` : 'this token';
  return { ok: true, text: `${p.tier} tier: ${p.percent}% of trading fees buy back and burn ${symbol}, for life${p.burned ? ` (${p.burnedText} burned so far)` : ''}.` };
}

/**
 * What the launch page says to a connected wallet with a registration on the chosen network, or null when it has none.
 * `now` is unix seconds.
 */
export function launchTierNotice(record, now = Math.floor(Date.now() / 1000)) {
  if (!record || !TIERS[Number(record.buybackBps)]) return null;
  const bps = Number(record.buybackBps), until = Number(record.expiresAt);
  const date = new Date(until * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  if (!(until > now)) return { live: false, tier: TIERS[bps], text: `Your ${TIERS[bps]} tier ended on ${date}. Tokens you launch now are standard (50/50).` };
  return { live: true, tier: TIERS[bps], percent: bps / 100, text: `${TIERS[bps]} tier: ${bps / 100}% of this token's trading fees will buy back and burn it, for life, out of Elpida's share. You still keep 50%. Applies to launches until ${date}.` };
}
