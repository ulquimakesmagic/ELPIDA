// Recolor the editable vector assets and manifest to match the black/green product theme.
import { readdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../apps/web/assets/brand/', import.meta.url);
const colors = { '#F0A030': '#76ED9A', '#F2B04A': '#76ED9A', '#10203A': '#080B09', '#E8EDF5': '#F2F7F3', '#F4F6F8': '#F2F7F3' };
for (const name of await readdir(root)) {
  if (!name.endsWith('.svg')) continue;
  const path = new URL(name, root);
  let source = await readFile(path, 'utf8');
  for (const [from, to] of Object.entries(colors)) source = source.replaceAll(from, to);
  await writeFile(path, source);
}
const manifest = JSON.parse(await readFile(new URL('site.webmanifest', root), 'utf8'));
manifest.theme_color = '#080B09';
manifest.background_color = '#080B09';
await writeFile(new URL('site.webmanifest', root), JSON.stringify(manifest));
// Cached brand assets must refresh alongside the theme; drafts and local chain state stay intact.
const htmlPath = new URL('../apps/web/index.html', import.meta.url);
const html = await readFile(htmlPath, 'utf8');
await writeFile(htmlPath, html.replace(/(\/assets\/brand\/[^"?]+)(?:\?v=[^"]+)?"/g, '$1?v=green-20261011"'));
