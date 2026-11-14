// Oracle Cloud hosting kit (deploy/oracle, docs/ORACLE_HOSTING.md; Malik, 13 November: move off Railway to cut cost).
// The scripts run on the VM; here they are checked for syntax, for the values the server is started with, for the
// staging copy never holding a signing key, and for the health report never printing a value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'deploy', 'oracle');
const scripts = readdirSync(dir).filter(f => f.endsWith('.sh'));

test('every Oracle script parses and is LF-only (it runs on Linux even from a Windows checkout)', () => {
  assert.deepEqual(scripts.sort(), ['doctor.sh', 'restore.sh', 'setup.sh', 'start.sh', 'update.sh']);
  for (const f of [...scripts, 'elpida.service', 'elpida-update.service', 'elpida-update.timer']) {
    if (f.endsWith('.sh')) assert.equal(spawnSync('bash', ['-n', join(dir, f)]).status, 0, `${f} parses`);
    assert.ok(!readFileSync(join(dir, f), 'utf8').includes('\r'), `${f} has no CR`);
  }
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^deploy\/oracle\/\*\* text eol=lf$/m);
});

function start(env) {
  const t = mkdtempSync(join(tmpdir(), 'elpida-oracle-')), fake = join(t, 'node');
  writeFileSync(fake, '#!/usr/bin/env bash\nnode -e "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),env:process.env}))" -- "$@"\n');
  chmodSync(fake, 0o755);
  const staging = join(t, 'staging.env');
  if (env.staging) writeFileSync(staging, env.staging);
  const r = spawnSync('bash', [join(dir, 'start.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env.vars, ELPIDA_NODE: fake, ELPIDA_STAGING_FILE: staging } });
  rmSync(t, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{"cwd"')));
}

const railway = { PORT: '8080', HOST: '0.0.0.0', ELPIDA_DATA_DIR: '/data', ELPIDA_PUBLIC_URL: 'https://elpida.fun', ELPIDA_V2_KEEPER_KEY: 'k1', ELPIDA_V2_KEEPER_SOLANA_KEY: 'k2', ELPIDA_TESTNET_RELAY_KEY: 'k3', ELPIDA_GRADUATION_KEY_FILE: '/etc/elpida/g.key', CIRCLE_API_KEY: 'c', CIRCLE_ENTITY_SECRET: 'c2', ELPIDA_BACKUP_ENABLED: 'true', PINATA_JWT: 'p' };

test('start.sh: the hosting values win over anything copied from Railway, and production keeps its keepers', () => {
  const { cwd, args, env } = start({ vars: railway });
  assert.equal(cwd, root.replace(/\/$/, ''));
  assert.deepEqual(args.slice(-1), ['apps/api/server.mjs']);
  assert.equal(env.HOST, '127.0.0.1', 'only cloudflared on this machine reaches the server');
  assert.equal(env.PORT, '3000');
  assert.equal(env.ELPIDA_DATA_DIR, '/var/lib/elpida');
  assert.equal(env.ELPIDA_BACKUP_WORK_DIR, '/var/lib/elpida-work');
  assert.equal(env.ELPIDA_TRUST_PROXY, 'cloudflare');
  assert.equal(env.NODE_ENV, 'production');
  for (const k of ['ELPIDA_V2_KEEPER_KEY', 'ELPIDA_V2_KEEPER_SOLANA_KEY', 'ELPIDA_TESTNET_RELAY_KEY', 'ELPIDA_GRADUATION_KEY_FILE', 'CIRCLE_API_KEY']) assert.equal(env[k], railway[k]);
  assert.equal(env.ELPIDA_BACKUP_ENABLED, 'true');
  assert.equal(env.ELPIDA_PUBLIC_URL, 'https://elpida.fun');
});

test('start.sh staging: no signing keys, no Circle, no backups, the staging address; everything else unchanged', () => {
  const { env } = start({ vars: railway, staging: 'ELPIDA_PUBLIC_URL=https://staging.elpida.fun\n' });
  for (const k of ['ELPIDA_V2_KEEPER_KEY', 'ELPIDA_V2_KEEPER_SOLANA_KEY', 'ELPIDA_TESTNET_RELAY_KEY', 'ELPIDA_GRADUATION_KEY_FILE', 'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET']) assert.equal(env[k], undefined, `${k} removed`);
  assert.equal(env.ELPIDA_BACKUP_ENABLED, 'false');
  assert.equal(env.ELPIDA_PUBLIC_URL, 'https://staging.elpida.fun');
  assert.equal(env.PINATA_JWT, 'p');
  assert.equal(env.HOST, '127.0.0.1');
});

test('the service runs start.sh as the elpida user with the variables file, restarts on failure, cannot gain privileges', () => {
  const unit = readFileSync(join(dir, 'elpida.service'), 'utf8');
  for (const line of ['User=elpida', 'EnvironmentFile=/etc/elpida/elpida.env', 'EnvironmentFile=-/etc/elpida/build.env', 'ExecStart=/opt/elpida/app/deploy/oracle/start.sh', 'Restart=always', 'NoNewPrivileges=true', 'ProtectHome=true', 'WantedBy=multi-user.target'])
    assert.match(unit, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('doctor.sh lists variable names and problems but never a value', { skip: process.getuid?.() !== 0 && 'needs root, as on the VM' }, () => {
  const t = mkdtempSync(join(tmpdir(), 'elpida-doctor-')), envFile = join(t, 'elpida.env');
  const secrets = ['0xdeadbeefSECRETKEY', 'r2-secret-ACCESS', 'https://staging.example.SECRET'];
  writeFileSync(envFile, [
    `ELPIDA_V2_KEEPER_KEY="${secrets[0]}"`,
    `export ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY=${secrets[1]}`,
    'ELPIDA_BACKUP_S3_ACCESS_KEY_ID="${{elpida-backups.ACCESS_KEY_ID}}"',
    `RAILWAY_PUBLIC_DOMAIN=${secrets[2]}`,
    '# a comment=not a name',
  ].join('\n') + '\n');
  const r = spawnSync('bash', [join(dir, 'doctor.sh')], { encoding: 'utf8', env: { ...process.env, ELPIDA_ENV_FILE: envFile } });
  rmSync(t, { recursive: true, force: true });
  const out = r.stdout + r.stderr;
  for (const s of [...secrets, 'elpida-backups.ACCESS_KEY_ID']) assert.ok(!out.includes(s), `never prints ${s}`);
  assert.match(out, /4 names, values not shown/);
  assert.match(out, /ELPIDA_BACKUP_S3_ACCESS_KEY_ID ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY ELPIDA_V2_KEEPER_KEY RAILWAY_PUBLIC_DOMAIN/);
  assert.match(out, /MISSING {2}ELPIDA_PUBLIC_URL/);
  assert.match(out, /MISSING {2}ELPIDA_BACKUP_ENCRYPTION_KEY/);
  assert.match(out, /REMOVE {3}RAILWAY_PUBLIC_DOMAIN/);
  assert.match(out, /FIX {6}line 3, ELPIDA_BACKUP_S3_ACCESS_KEY_ID: still a Railway reference/);
});

test('scripts never echo the variables file or the tunnel token', () => {
  for (const f of scripts) {
    const s = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(s, /cat\s+["']?\/etc\/elpida\/elpida\.env|cat\s+"?\$ENVF/, `${f} does not print the variables file`);
    assert.doesNotMatch(s, /echo\s+"?\$TOKEN/, `${f} does not print the token`);
  }
  assert.match(readFileSync(join(dir, 'setup.sh'), 'utf8'), /read -rs TOKEN/);
});

test('automatic deploys: every 5 minutes, only a new commit, a failed commit is not retried, the script survives rewriting itself', () => {
  const timer = readFileSync(join(dir, 'elpida-update.timer'), 'utf8'), svc = readFileSync(join(dir, 'elpida-update.service'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(svc, /^ExecStart=\/bin\/bash \/opt\/elpida\/app\/deploy\/oracle\/update\.sh --auto$/m);
  const u = readFileSync(join(dir, 'update.sh'), 'utf8');
  assert.match(u, /\nmain "\$@"\nexit\n$/, 'the whole script is parsed before git rewrites it');
  assert.match(u, /grep -qx "\$target" "\$FAILED"/);
  assert.match(readFileSync(join(dir, 'setup.sh'), 'utf8'), /systemctl enable --now elpida-update\.timer/);
});
