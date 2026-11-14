// Every server and site module must at least parse: a merge of two PRs that each added an import after the same line
// left server.mjs with a duplicate import on 14 November, and the live site crash-looped for an hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const dir of ['apps/api', 'apps/web', 'packages/core', 'packages/indexer', 'packages/solana']) {
  test(`${dir}: every .mjs parses`, () => {
    for (const f of readdirSync(root + dir).filter(f => f.endsWith('.mjs'))) {
      const r = spawnSync(process.execPath, ['--check', `${root}${dir}/${f}`], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${dir}/${f}: ${r.stderr.split('\n').slice(0, 6).join('\n')}`);
    }
  });
}
