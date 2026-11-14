// Loads a classic vendor script (the Solana web3 library, the chart library) the first time a page needs it, instead of
// on every page. Together they were about 1.4 MB of JavaScript on the home page, Learn and Analytics, which use neither
// (PageSpeed, 14 Nov). Each script is requested once; later calls share the same promise. Same-origin, so the CSP
// (script-src 'self') is unchanged.
const loads = new Map();
// This module is served as /vendor-loader.mjs?v=<build>; the same build id makes the vendor URL cacheable for a year.
const version = (() => { try { return new URL(import.meta.url).searchParams.get('v'); } catch { return null; } })();
const versioned = src => (version ? `${src}?v=${encodeURIComponent(version)}` : src);

export function loadScript(path) {
  const src = versioned(path);
  if (!loads.has(src)) {
    loads.set(src, new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing?.dataset.loaded === 'true') return resolve();
      const s = existing ?? document.createElement('script');
      s.addEventListener('load', () => { s.dataset.loaded = 'true'; resolve(); }, { once: true });
      s.addEventListener('error', () => { loads.delete(src); reject(new Error(`Could not load ${src}. Check the connection and retry.`)); }, { once: true });
      if (!existing) { s.src = src; s.async = true; document.head.append(s); }
    }));
  }
  return loads.get(src);
}

export const SOLANA_WEB3 = '/vendor/solana-web3.js';
export const CHARTS = '/vendor/lightweight-charts.js';
/** The Solana web3 library (window.solanaWeb3), loaded on first use. */
export const ensureSolanaLibrary = () => (globalThis.solanaWeb3 ? Promise.resolve() : loadScript(SOLANA_WEB3));
/** The chart library (window.LightweightCharts), loaded on first use. */
export const ensureChartLibrary = () => (globalThis.LightweightCharts ? Promise.resolve() : loadScript(CHARTS));
