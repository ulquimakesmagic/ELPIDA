// Versioned static assets for the web app.
//
// The app is ~60 ES modules. Without help a browser discovers them one import level at a time (4-5 round trips), and
// with `Cache-Control: no-cache` it revalidates every one of them on every visit: from Lagos that was ~10 s before the
// page could run. Here every import of a known module gets `?v=<build>` appended, those URLs are served as immutable
// (a deploy changes the build, so the URLs change), and index.html lists the whole static import graph as
// `modulepreload` links, so the browser fetches it in one round trip. Unversioned requests still work, uncached.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"\s?#]+\.m?js)\2/g;
const STATIC_IMPORT = /(?:\bfrom\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"\s?#]+\.m?js)\1/g;
const HTML_ASSET = /(\s(?:src|href)=")(\/[^"?#]+\.(?:m?js|css))(")/g;

/** The URL path a specifier names, seen from the module at `from` (both are site paths such as /token-page.mjs). */
export function resolveSpecifier(from, specifier) {
  if (specifier.startsWith('/')) return specifier;
  return new URL(specifier, `https://site${from}`).pathname;
}

/** Appends `?v=version` to every import of a served module; anything else is left as written. */
export function versionImports(source, from, known, version) {
  return source.replace(IMPORT, (match, lead, quote, specifier) => known.has(resolveSpecifier(from, specifier)) ? `${lead}${quote}${specifier}?v=${version}${quote}` : match);
}

/** Static imports of a module (dynamic `import()` is loaded on demand and is not preloaded). */
export function staticImports(source, from) {
  return [...source.matchAll(STATIC_IMPORT)].map(m => resolveSpecifier(from, m[2]));
}

/**
 * `files`: Map of site path → absolute file path for every served script and stylesheet. `version`: the build id, or
 * null in development (files are then read fresh on every request and nothing is cached).
 */
export function createStaticAssets({ files, entry = '/app.mjs', version = null }) {
  const known = new Set(files.keys());
  const cache = new Map();
  const isModule = path => /\.m?js$/.test(path);
  const read = path => readFileSync(files.get(path), 'utf8');
  const body = path => {
    if (version && cache.has(path)) return cache.get(path);
    const raw = read(path);
    const out = version && isModule(path) && path.endsWith('.mjs') ? versionImports(raw, path, known, version) : raw;
    if (version) cache.set(path, out);
    return out;
  };
  /** Every module the entry reaches through static imports, entry first. */
  const graph = () => {
    const seen = new Set(), order = [];
    const walk = path => { if (seen.has(path) || !known.has(path)) return; seen.add(path); order.push(path); for (const dep of staticImports(read(path), path)) walk(dep); };
    walk(entry);
    return order;
  };
  let preload = null;
  return {
    version,
    has: path => known.has(path),
    /** The response for a served script or stylesheet: body, and whether it may be cached for good. */
    serve(path, requestedVersion) {
      return { body: body(path), immutable: Boolean(version) && requestedVersion === version };
    },
    /** index.html with versioned script and stylesheet URLs and a modulepreload list of the app's import graph. */
    html(source) {
      if (!version) return source;
      preload ??= graph().map(path => `  <link rel="modulepreload" href="${path}?v=${version}">`).join('\n');
      const versioned = source.replace(HTML_ASSET, (match, lead, path, end) => known.has(path) ? `${lead}${path}?v=${version}${end}` : match);
      return versioned.replace(/(\s*<script type="module")/, `\n${preload}$1`);
    },
  };
}

/** A build id from the content of every served file, so it changes exactly when the client code does. */
export function contentVersion(files) {
  const hash = createHash('sha256');
  for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update(readFileSync(resolve(file)));
  return hash.digest('hex').slice(0, 12);
}
