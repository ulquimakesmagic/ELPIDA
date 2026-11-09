// Flywheel burn labels: how much of a token's supply the flywheels have bought and burned, for Explore cards, the token
// page and its safety checklist. Pure helpers, no DOM. The API adds `flywheelBurned` (whole tokens, a decimal string)
// to tokens the V2 flywheel vault or the Model 10 flywheel keeper has bought and burned; every Elpida token starts with
// 1,000,000,000, so the share is of that original supply.

export const ORIGINAL_SUPPLY = 1_000_000_000;

const count = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? String(Math.floor(n)) : '<1';

/** Share of supply as a short label: two decimals, more only while it would read as 0.00%. */
export function percentText(share) {
  if (!(share > 0)) return '0%';
  if (share >= 100) return '100%';
  if (share >= 0.01) return `${share.toFixed(2)}%`;
  if (share >= 0.001) return `${share.toFixed(3)}%`;
  return '<0.001%';
}

/** The flywheel burns of a token, or null when the flywheels have not burned any of it. */
export function flywheelBurnOf(token) {
  const burned = Number(token?.flywheelBurned);
  if (!Number.isFinite(burned) || burned <= 0) return null;
  const share = Math.min(100, burned / ORIGINAL_SUPPLY * 100);
  return { burned, burnedText: count(burned), share, percent: percentText(share) };
}

/** Short tag text and its accessible title; null for tokens the flywheels have not burned. */
export function flywheelChip(token) {
  const b = flywheelBurnOf(token);
  if (!b) return null;
  const symbol = token.symbol ? `$${token.symbol}` : 'this token';
  return { text: `${b.percent} burned`, title: `Flywheel: ${b.burnedText} ${symbol} bought and burned, ${b.percent} of the 1B supply.` };
}

/** The safety-checklist line; null for tokens the flywheels have not burned. */
export function flywheelCheck(token) {
  const b = flywheelBurnOf(token);
  if (!b) return null;
  const symbol = token.symbol ? `$${token.symbol}` : 'this token';
  return { ok: true, text: `The Elpida flywheel has bought and burned ${b.burnedText} ${symbol} (${b.percent} of supply).` };
}
