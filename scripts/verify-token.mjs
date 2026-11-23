#!/usr/bin/env node
// Publishes one launched token's source on its explorer now, without waiting for the keeper's hourly job
// (apps/api/token-verifier.mjs). Needs ELPIDA_MAINNET_RPC_URL (that chain) and ETHERSCAN_API_KEY (or ELPIDA_EXPLORER_API_KEY).
//   node scripts/verify-token.mjs --plan deployments/plans/bnb-mainnet.json --token 0xEEcA39F2aF81296De89685e6dDdA58acD5BA1053
//   Add --save to write the files an explorer's web form needs (no paid API). Add --debug [--tx <launch tx>] to compare the explorer's copy of the creation code with this checkout's build instead of submitting.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { TokenVerifier, tokenArgs, TOKEN_CONTRACT } from '../apps/api/token-verifier.mjs';
import { Contract, getAddress } from 'ethers';
import { standardInput } from './v2-explorer-verify.mjs';
import { createRequire } from 'node:module';
import { EXPLORERS } from './v2-explorer-verify.mjs';

const rest = process.argv.slice(2), arg = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
const planPath = arg('plan'), tokens = (arg('token') ?? '').split(',').map(x => x.trim()).filter(Boolean);
if (!planPath || !tokens.length) { console.log('usage: node scripts/verify-token.mjs --plan deployments/plans/<key>.json --token 0x…[,0x…]'); process.exit(2); }
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const record = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', `${plan.key}.json`), 'utf8'));
const apiKey = process.env.ETHERSCAN_API_KEY ?? process.env.ELPIDA_EXPLORER_API_KEY, rpc = process.env.ELPIDA_MAINNET_RPC_URL;
if (!rpc || (!apiKey && !rest.includes('--save'))) { console.error('Set ELPIDA_MAINNET_RPC_URL and ETHERSCAN_API_KEY.'); process.exit(1); }
// --save: writes what an explorer's web form asks for (no API plan needed), for each token: the Standard JSON input with
// the line endings that match the chain, and the ABI-encoded constructor arguments. Nothing is submitted.
if (rest.includes('--save')) {
  const { writeFileSync } = await import('node:fs');
  const { tokenRuntime } = await import('../apps/api/token-verifier.mjs');
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  for (const raw of tokens) {
    const address = getAddress(raw.toLowerCase()), code = (await provider.getCode(address)).toLowerCase();
    const eol = ['lf', 'crlf'].find(e => tokenRuntime(e) === code);
    if (!eol) { console.log(`FAIL ${address}: the code on chain is not an ElpidaV2Token built from this checkout`); continue; }
    const c = new Contract(address, ['function name() view returns(string)', 'function symbol() view returns(string)'], provider), [name, symbol] = await Promise.all([c.name(), c.symbol()]);
    const base = `verify-${plan.key}-${address.toLowerCase()}`;
    writeFileSync(`${base}-standard-input.json`, JSON.stringify(standardInput(TOKEN_CONTRACT, { eol })));
    writeFileSync(`${base}-constructor-args.txt`, tokenArgs(name, symbol, record.contracts.hook) + '\n');
    console.log(`ok   ${address} (${name} / ${symbol}, ${eol.toUpperCase()} line endings): ${base}-standard-input.json and ${base}-constructor-args.txt`);
    console.log(`     Form: ${EXPLORERS[Number(plan.chainId)]}/verifyContract?a=${address} · Solidity (Standard-Json-Input) · compiler v0.8.26+commit.8a97fa7a · MIT · contract ${TOKEN_CONTRACT}`);
  }
  process.exit(0);
}
// --debug: compares the explorer's copy of each token's creation code with this checkout's build, part by part.
if (rest.includes('--debug')) {
  const solc = createRequire(import.meta.url)('solc-0.8.26'), provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  for (const raw of tokens) {
    const address = getAddress(raw.toLowerCase()), code = (await provider.getCode(address)).toLowerCase();
    const r = await (await fetch(`https://api.etherscan.io/v2/api?chainid=${plan.chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${encodeURIComponent(apiKey)}`)).json();
    const created = r.result?.[0] ?? {};
    let onchainInit = String(created.creationBytecode ?? '').toLowerCase();
    // --tx <launch tx>: the token's real creation code from the node's call trace (when the explorer API will not say).
    const txArg = rest.includes('--tx') ? rest[rest.indexOf('--tx') + 1] : null;
    if (!onchainInit && txArg) {
      try {
        const trace = await provider.send('debug_traceTransaction', [txArg, { tracer: 'callTracer' }]);
        const find = c => (['CREATE', 'CREATE2'].includes(c.type) && String(c.to).toLowerCase() === address.toLowerCase() ? c : (c.calls ?? []).map(find).find(Boolean));
        const hit = find(trace); onchainInit = String(hit?.input ?? '').toLowerCase();
        console.log(`  node trace: ${hit ? `${hit.type} by ${hit.from}, ${onchainInit.length / 2 - 1} bytes of creation code` : 'the token creation was not found in that transaction'}`);
      } catch (e) { console.log(`  node trace refused: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`); }
    }
    const c = new Contract(address, ['function name() view returns(string)', 'function symbol() view returns(string)'], provider), [name, symbol] = await Promise.all([c.name(), c.symbol()]);
    console.log(`${address}: name "${name}", symbol "${symbol}", created by ${created.contractCreator ?? '?'} in ${created.txHash ?? '?'}`);
    console.log(`  explorer creation code: ${onchainInit ? onchainInit.length / 2 - 1 + ' bytes' : 'none returned (' + JSON.stringify(r).slice(0, 160) + ')'}`);
    for (const eol of ['lf', 'crlf']) {
      const out = JSON.parse(solc.compile(JSON.stringify(standardInput(TOKEN_CONTRACT, { eol })))), [file, n] = TOKEN_CONTRACT.split(':'), ev = out.contracts[file][n].evm;
      const init = '0x' + ev.bytecode.object.toLowerCase(), args = tokenArgs(name, symbol, record.contracts.hook);
      console.log(`  ${eol}: runtime ${('0x' + ev.deployedBytecode.object.toLowerCase()) === code ? 'MATCHES' : 'differs'}; creation code ${onchainInit.startsWith(init) ? 'MATCHES' : 'differs'}; arguments ${onchainInit === init + args ? 'MATCH' : onchainInit.startsWith(init) ? 'DIFFER: explorer has ' + onchainInit.slice(init.length) + ' / ours ' + args : '-'}`);
    }
  }
  process.exit(0);
}
const memory = new Map(), v = new TokenVerifier({ apiKey, perTick: tokens.length });
const r = await v.run({ chainId: Number(plan.chainId), provider: new JsonRpcProvider(rpc, undefined, { staticNetwork: true }), hook: record.contracts.hook, tokens: tokens.map(address => ({ address })),
  state: { get: (k, f) => memory.get(k) ?? f, set: (k, x) => memory.set(k, x) }, now: Math.floor(Date.now() / 1000) });
for (const x of r.submitted) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.address}: ${x.detail}${x.ok ? ` ${EXPLORERS[Number(plan.chainId)]}/address/${x.address}#code` : ''}`);
process.exit(r.submitted.every(x => x.ok) ? 0 : 1);
