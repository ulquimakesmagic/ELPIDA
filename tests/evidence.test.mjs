// The evidence publisher must never copy a provider key into a committed file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scrub,writeEvidence,evidenceName} from '../scripts/evidence.mjs';

test('credentials are removed from URLs and key-shaped fields',()=>{
  const clean=scrub({
    rpc:'https://user:pass@base-sepolia.example/v1?api_key=abc123&other=1',
    privateKey:'0xdeadbeef',
    nested:{mnemonic:'twelve words',keep:'this'},
    block:12n,
  });
  assert.equal(clean.rpc,'https://redacted@base-sepolia.example/v1?api_key=REDACTED&other=1');
  assert.equal(clean.privateKey,undefined);
  assert.equal(clean.nested.mnemonic,undefined);
  assert.equal(clean.nested.keep,'this');
  assert.equal(clean.block,'12','BigInt is stringified for JSON');
});

test('a report is published with provenance and a predictable name',()=>{
  const dir=mkdtempSync(join(tmpdir(),'elpida-evidence-'));
  const path=writeEvidence({network:'base-sepolia',block:48289973,result:'PASS',checks:['launch','graduation']},{dir});
  assert.match(path,/base-sepolia-fork-48289973\.json$/);

  const report=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(report.kind,'local-fork');
  assert.equal(report.result,'PASS');
  assert.equal(report.block,48289973);
  assert.deepEqual(report.checks,['launch','graduation']);
  assert.match(report.recordedAt,/^\d{4}-\d{2}-\d{2}T/);
});

test('the file name identifies the chain, the block and optionally the date',()=>{
  assert.equal(evidenceName({network:'bnb-testnet',block:138485798}),'bnb-testnet-fork-138485798.json');
  assert.equal(evidenceName({network:'bnb-testnet',block:138485798,date:'2026-10-25'}),'bnb-testnet-fork-138485798-2026-10-25.json');
  assert.equal(evidenceName({upstreamChain:84532,block:7}),'chain-fork-7.json');
});
