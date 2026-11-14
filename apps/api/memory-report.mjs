// Where the server's memory goes (Malik, 13 November: Railway bills memory per GB-minute and the service averages
// about 2.5 GB, while a fresh local start uses about 330 MB). Reports the process (V8 heap, native, buffers) and,
// when the container exposes it, the cgroup's own count, split into program memory (anon) and file cache (file):
// a large `file` share is the kernel caching SQLite pages, which a container memory limit reclaims; a large heap is
// the program holding data. Logged every 15 minutes and shown to operators; numbers in MB, nothing sensitive.
import { readFileSync } from 'node:fs';

const MB = 1048576;
const mb = n => (Number.isFinite(n) ? Math.round(n / MB) : null);

function read(path, readFile) {
  try { return String(readFile(path, 'utf8')).trim(); } catch { return null; }
}

/** cgroup v2 (`memory.current`, `memory.stat`) or v1 (`memory.usage_in_bytes`, `memory.stat`); null outside a container. */
export function cgroupMemory(readFile = readFileSync) {
  const stat = text => Object.fromEntries(String(text ?? '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 2).map(([k, v]) => [k, Number(v)]));
  const v2 = read('/sys/fs/cgroup/memory.current', readFile);
  if (v2 !== null && /^\d+$/.test(v2)) {
    const s = stat(read('/sys/fs/cgroup/memory.stat', readFile)), max = read('/sys/fs/cgroup/memory.max', readFile);
    return { version: 2, current: mb(Number(v2)), anon: mb(s.anon), file: mb(s.file), limit: max && /^\d+$/.test(max) ? mb(Number(max)) : null };
  }
  const v1 = read('/sys/fs/cgroup/memory/memory.usage_in_bytes', readFile);
  if (v1 !== null && /^\d+$/.test(v1)) {
    const s = stat(read('/sys/fs/cgroup/memory/memory.stat', readFile)), max = Number(read('/sys/fs/cgroup/memory/memory.limit_in_bytes', readFile));
    return { version: 1, current: mb(Number(v1)), anon: mb(s.total_rss ?? s.rss), file: mb(s.total_cache ?? s.cache), limit: Number.isFinite(max) && max < 2 ** 60 ? mb(max) : null };
  }
  return null;
}

/** The whole report: process memory (MB), the V8 heap ceiling, the cgroup split when there is one, and extras. */
export function memoryReport({ usage = process.memoryUsage(), heapLimit = null, readFile = readFileSync, extra = {} } = {}) {
  return {
    rss: mb(usage.rss), heapUsed: mb(usage.heapUsed), heapTotal: mb(usage.heapTotal), external: mb(usage.external), arrayBuffers: mb(usage.arrayBuffers),
    heapLimit: heapLimit === null ? null : mb(heapLimit),
    cgroup: cgroupMemory(readFile),
    ...extra,
  };
}
