// Native pricing: every chain charges its creation fee and prices its curves in its own coin
// (SOL, ETH, BNB…). The team sets the values in config/native-pricing.json; see its _readme.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PRICING_PATH = fileURLToPath(new URL('../../config/native-pricing.json', import.meta.url));
/** EVM curves complete when 800M of the 1B supply is sold, at 16x the starting FDV. */
export const EVM_END_MULTIPLE = 16;

const amount = (value, label) => {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text) || !(Number(text) > 0)) throw new Error(`${label} must be a positive number written as a string, got "${value}".`);
  return text;
};

/** Reads and checks config/native-pricing.json. Throws with a readable message on a bad value. */
export function loadPricing(path = PRICING_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const solana = {}, evm = {};
  for (const [cluster, p] of Object.entries(raw.solana ?? {})) {
    const startFdv = amount(p.startFdv, `solana.${cluster}.startFdv`), endFdv = amount(p.endFdv, `solana.${cluster}.endFdv`);
    if (!(Number(endFdv) > Number(startFdv))) throw new Error(`solana.${cluster}.endFdv must be greater than startFdv.`);
    if (Number(amount(p.launchFee, `solana.${cluster}.launchFee`)) > 100) throw new Error(`solana.${cluster}.launchFee looks too large (over 100 SOL).`);
    solana[cluster] = { launchFee: String(p.launchFee), startFdv, endFdv, testSized: !!p.testSized };
  }
  for (const [key, p] of Object.entries(raw.evm ?? {})) {
    evm[key] = { launchFee: amount(p.launchFee, `evm.${key}.launchFee`), startFdv: amount(p.startFdv, `evm.${key}.startFdv`) };
  }
  return { solana, evm };
}

/** Pricing for one Solana cluster (devnet, localnet or mainnet). */
export function solanaPricing(cluster, pricing = loadPricing()) {
  const p = pricing.solana[cluster];
  if (!p) throw new Error(`config/native-pricing.json has no solana.${cluster} entry.`);
  return p;
}

/**
 * EVM factory values in wei: `virtualQuote` is the curve's virtual native reserve that gives `startFdv`
 * (FDV = virtualQuote x supply / virtualToken, and virtualToken / supply = 16/15).
 */
export function evmPricing(key, pricing = loadPricing()) {
  const p = pricing.evm[key];
  if (!p) throw new Error(`config/native-pricing.json has no evm.${key} entry.`);
  const wei = text => { const [w, f = ''] = text.split('.'); return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18)); };
  return { ...p, launchFeeWei: wei(p.launchFee), virtualQuoteWei: wei(p.startFdv) * 16n / 15n };
}
