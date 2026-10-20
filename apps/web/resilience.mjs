// Keeps an open tab calm through a redeploy. While the server restarts the page keeps working as far as it can and shows a
// small "reconnecting" strip instead of a stack of errors; when the server returns with a NEW build the tab refreshes itself,
// but only where that cannot lose work (Explore or Docs with nothing being typed). Everywhere else it offers a Refresh button.
export const POLL_MS = 20000;
const SAFE_HASHES = new Set(['', '#', '#/', '#/docs']);

/** Delay before the next probe while the server is unreachable: 3s, 6s, 12s, then 15s. */
export const retryDelay = failures => Math.min(15000, 3000 * 2 ** Math.max(0, failures - 1));

/** Is a refresh harmless right now? Only on read-only routes and when no field is focused. */
export function safeToReload({ hash = '', activeTag = '' } = {}) {
  return SAFE_HASHES.has(String(hash).split('?')[0]) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(String(activeTag).toUpperCase());
}

/** What to do after a health probe. `build` is null when the probe failed. */
export function decide({ known, build, failures, hash, activeTag }) {
  if (build === null) return { failures: failures + 1, banner: failures + 1 >= 2 ? 'offline' : null, reload: false };
  const changed = Boolean(known) && known !== 'dev' && build !== 'dev' && build !== known;
  if (!changed) return { failures: 0, banner: null, reload: false, known: known ?? build };
  return safeToReload({ hash, activeTag }) ? { failures: 0, banner: null, reload: true } : { failures: 0, banner: 'update', reload: false };
}

async function probe() {
  try {
    const r = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const body = await r.json();
    return typeof body.build === 'string' ? body.build : 'dev';
  } catch { return null; }
}

export function startResilience({ doc = document, loc = location, request = probe } = {}) {
  let known = null, failures = 0, timer = null;
  const bar = doc.createElement('div');
  bar.className = 'conn-bar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite'); bar.hidden = true;
  const text = doc.createElement('span'), action = doc.createElement('button');
  action.type = 'button'; action.className = 'conn-action'; action.textContent = 'Refresh'; action.hidden = true;
  action.addEventListener('click', () => loc.reload());
  bar.append(text, action);
  doc.body.append(bar);
  const show = kind => {
    bar.hidden = !kind; bar.dataset.kind = kind ?? '';
    action.hidden = kind !== 'update';
    text.textContent = kind === 'offline' ? 'Elpida is updating. Reconnecting…' : kind === 'update' ? 'A new version of Elpida is ready.' : '';
  };
  const tick = async () => {
    const build = await request();
    const next = decide({ known, build, failures, hash: loc.hash, activeTag: doc.activeElement?.tagName });
    failures = next.failures; if (next.known) known = next.known;
    show(next.banner);
    if (next.reload) return loc.reload();
    schedule(build === null ? retryDelay(failures) : POLL_MS);
  };
  const schedule = ms => { clearTimeout(timer); timer = setTimeout(() => { if (doc.visibilityState === 'hidden' && failures === 0) return schedule(POLL_MS); tick(); }, ms); };
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') schedule(500); });
  request().then(build => { if (build) known = build; schedule(POLL_MS); });
  return { stop: () => clearTimeout(timer), tick };
}
