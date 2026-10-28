// Read-only HTTPS discovery. Produces a review manifest; never edits the live registry or sends chain transactions.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOndoAssetPage } from '../packages/core/ondo-assets.mjs';

export async function discoverOndoAssets(symbols, { fetchPage = fetch, accessed = new Date().toISOString().slice(0, 10) } = {}) {
  const assets = [];
  for (const symbol of symbols) {
    if (!/^[A-Za-z0-9]+on$/.test(symbol)) throw new Error('Expected an Ondo stock symbol ending in on.');
    const source = `https://app.ondo.finance/assets/${symbol.toLowerCase()}`;
    const response = await fetchPage(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Issuer page returned HTTP ${response.status}.`);
    assets.push(...parseOndoAssetPage({ html: await response.text(), source, symbol, accessed }));
  }
  if (new Set(assets.map(a => `${a.network}:${a.address}`)).size !== assets.length) throw new Error('Duplicate canonical asset identity.');
  return { provider: 'ondo', accessed, note: 'Issuer address discovery only. No capability is verified or enabled.', assets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await discoverOndoAssets(process.argv.slice(2).length ? process.argv.slice(2) : ['NVDAon', 'TSLAon', 'SPYon']);
  const output = resolve('backups/ondo-address-review.json');
  const { mkdirSync } = await import('node:fs'); mkdirSync('backups', { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Discovered ${manifest.assets.length} canonical records; review manifest: ${output}. Registry unchanged.`);
}
