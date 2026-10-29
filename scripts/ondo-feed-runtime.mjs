import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { keccak256 } from 'ethers';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';
import { compareDualAggregatorRuntime, DUAL_REFERENCE } from './lib/ondo-feed-runtime.mjs';

let rpc;
try {
  const input = JSON.parse(readFileSync('backups/equity-fork/ethereum-ondo-feed-candidates.json', 'utf8'));
  if (input.network !== 'ethereum' || input.chainId !== 1) throw new Error();
  const endpoint = process.env.ELPIDA_EQUITY_FORK_RPC_ETHEREUM ?? process.env.ELPIDA_EQUITY_FORK_RPC;
  const snapshot = await forkSnapshot(endpoint, 1, input.block);
  if (snapshot.hash !== input.blockHash) throw new Error();
  rpc = await createForkRpc({ rpc: endpoint, snapshot, cacheDir: 'cache/equity-rpc' });
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  const reference = await rpc.request('eth_getCode', [DUAL_REFERENCE.address, block]);
  const candidates = input.assets.flatMap(asset => asset.candidates.map(candidate => ({ symbol: asset.symbol, proxy: candidate.proxy, aggregator: candidate.observations.aggregator?.[0] })));
  if (candidates.length === 0 || candidates.length > 20) throw new Error();
  const results = [];
  for (const candidate of candidates) {
    if (!/^0x[0-9a-f]{40}$/i.test(candidate.aggregator ?? '')) throw new Error();
    const code = await rpc.request('eth_getCode', [candidate.aggregator, block]);
    results.push({ ...candidate, codeHash: keccak256(code), ...compareDualAggregatorRuntime(reference, code) });
  }
  const report = { network: 'ethereum', chainId: 1, block: snapshot.number, blockHash: snapshot.hash, reference: DUAL_REFERENCE, results,
    liveCapabilitiesApproved: false, note: 'Pinned read-only implementation-family comparison. Candidate report identities are inputs, not an approved feed registry. Offchain total-return and corporate-action semantics remain unverified.' };
  mkdirSync('backups/equity-fork', { recursive: true });
  writeFileSync('backups/equity-fork/ethereum-ondo-feed-runtime.json', JSON.stringify(report, null, 2));
  console.log(`Reference-family matches: ${results.filter(r => r.matchesReferenceFamily).length}/${results.length}; semantics remain UNVERIFIED. Report: backups/equity-fork/ethereum-ondo-feed-runtime.json`);
  if (!results.every(r => r.matchesReferenceFamily)) process.exitCode = 1;
} catch { console.error('Runtime comparison incomplete; verify pinned candidate observations and reference identity. No semantic or live approval.'); process.exitCode = 1; }
finally { if (rpc) await rpc.close(); }
