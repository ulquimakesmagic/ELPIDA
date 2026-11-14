// Memory reporting (Malik, 13 November: cut Railway's memory bill). The report must tell program memory from the
// kernel's file cache inside a container, so the fix can target the right one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { memoryReport, cgroupMemory } from '../apps/api/memory-report.mjs';

const MB = 1048576;
const files = map => path => { if (path in map) return map[path]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

test('cgroup v2: current, program memory (anon), file cache and the limit, in MB', () => {
  const read = files({
    '/sys/fs/cgroup/memory.current': `${2560 * MB}\n`,
    '/sys/fs/cgroup/memory.max': `${8192 * MB}\n`,
    '/sys/fs/cgroup/memory.stat': `anon ${600 * MB}\nfile ${1900 * MB}\nkernel 1234\n`,
  });
  assert.deepEqual(cgroupMemory(read), { version: 2, current: 2560, anon: 600, file: 1900, limit: 8192 });
  assert.equal(cgroupMemory(files({ '/sys/fs/cgroup/memory.current': '5', '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.stat': '' })).limit, null, 'no limit');
});

test('cgroup v1 and no cgroup at all', () => {
  const read = files({
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(1024 * MB),
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/memory/memory.stat': `cache ${700 * MB}\nrss ${300 * MB}\ntotal_cache ${700 * MB}\ntotal_rss ${300 * MB}\n`,
  });
  assert.deepEqual(cgroupMemory(read), { version: 1, current: 1024, anon: 300, file: 700, limit: null });
  assert.equal(cgroupMemory(files({})), null);
});

test('the report: process memory in MB, the heap ceiling, extras, and only numbers', () => {
  const r = memoryReport({ usage: { rss: 400 * MB, heapUsed: 90 * MB, heapTotal: 120 * MB, external: 80 * MB, arrayBuffers: 40 * MB }, heapLimit: 2048 * MB, readFile: files({}), extra: { streams: 3 } });
  assert.deepEqual(r, { rss: 400, heapUsed: 90, heapTotal: 120, external: 80, arrayBuffers: 40, heapLimit: 2048, cgroup: null, streams: 3 });
  const live = memoryReport();
  assert.ok(live.rss > 0 && live.heapUsed > 0);
});

test('the container starts node directly with fewer malloc arenas; the server logs memory every 15 minutes and shows it to operators', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const docker = readFileSync(root + 'Dockerfile', 'utf8'), server = readFileSync(root + 'apps/api/server.mjs', 'utf8');
  const admin = readFileSync(root + 'apps/web/admin-view.mjs', 'utf8');
  assert.match(docker, /^CMD \["node", "--env-file-if-exists=\.env", "apps\/api\/server\.mjs"\]$/m);
  assert.match(docker, /^ENV MALLOC_ARENA_MAX=2$/m);
  assert.match(server, /event:'memory'/);
  assert.match(server, /memory:memoryNow\(\)/);
  assert.match(server, /clearInterval\(memoryTimer\)/);
  assert.match(admin, /card\('Server memory'/);
});

test('vanity grinders run with a small heap and finished ones are forgotten', () => {
  const src = readFileSync(fileURLToPath(new URL('../apps/api/vanity-mints.mjs', import.meta.url)), 'utf8');
  assert.match(src, /resourceLimits: \{ maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 \}/);
  assert.match(src, /this\.current = this\.current\.filter\(w => w !== worker\)/);
});
