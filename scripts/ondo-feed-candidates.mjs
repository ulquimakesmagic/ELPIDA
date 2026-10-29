// Read-only discovery. Directory labels are candidates, never asset/feed approval.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Interface, keccak256 } from 'ethers';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';

export function ethereumOndoFeedCandidates(records, assets) {
  if (!Array.isArray(records) || !Array.isArray(assets)) throw new Error('Directory and registry lists required.');
  const canonical = assets.filter(a => a.provider === 'ondo' && a.network === 'ethereum');
  return canonical.map(asset => ({ token: asset.address, symbol: asset.symbol, network: 'ethereum',
    candidates: records.filter(r => r.docs?.blockchainName === 'Ethereum'
      && typeof r.docs.baseAsset === 'string' && r.docs.baseAsset.toUpperCase() === asset.symbol.toUpperCase()
      && r.docs.quoteAsset === 'USD' && /^0x[0-9a-f]{40}$/i.test(r.proxyAddress ?? '')).map(r => ({
        name: r.name, path: r.path, proxy: r.proxyAddress, secondaryProxy: r.secondaryProxyAddress ?? null,
        heartbeatSec: r.heartbeat, directoryDecimals: r.decimals, productType: r.docs.productTypeCode,
        semanticsVerified: false, statusSourceVerified: false, liveCapabilitiesApproved: false })),
    semanticsVerified: false, liveCapabilitiesApproved: false }));
}

export async function main() {
  const source = 'https://reference-data-directory.vercel.app/feeds-mainnet.json';
  let rpc;
  try {
    const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error();
    const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
    const assets = ethereumOndoFeedCandidates(await response.json(), registry.assets);
    const candidates = assets.flatMap(a => a.candidates); if (candidates.length > 20) throw new Error();
    const endpoint = process.env.ELPIDA_EQUITY_FORK_RPC_ETHEREUM ?? process.env.ELPIDA_EQUITY_FORK_RPC;
    const snapshot = await forkSnapshot(endpoint, 1, process.env.ELPIDA_EQUITY_FORK_BLOCK);
    rpc = await createForkRpc({ rpc: endpoint, snapshot, cacheDir: 'cache/equity-rpc' });
    const block = { blockHash: snapshot.hash, requireCanonical: true };
    const abi = new Interface(['function aggregator() view returns(address)', 'function decimals() view returns(uint8)', 'function description() view returns(string)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function typeAndVersion() view returns(string)', 'function owner() view returns(address)']);
    for (const candidate of candidates) {
      candidate.observations = {};
      try { candidate.observations.proxyCodeHash = keccak256(await rpc.request('eth_getCode', [candidate.proxy, block])); }
      catch { candidate.observations.codeUnverified = true; }
      for (const method of ['aggregator', 'decimals', 'description', 'latestRoundData']) {
        try { candidate.observations[method] = Array.from(abi.decodeFunctionResult(method, await rpc.request('eth_call', [{ to: candidate.proxy, data: abi.encodeFunctionData(method) }, block]))).map(v => typeof v === 'bigint' ? v.toString() : v); }
        catch { candidate.observations[method] = { unverified: true }; }
      }
      const target = candidate.observations.aggregator?.[0];
      candidate.aggregatorProbes = { sourceAuditVerified: false };
      if (/^0x[0-9a-f]{40}$/i.test(target ?? '')) for (const method of ['typeAndVersion', 'owner']) {
        try { candidate.aggregatorProbes[method] = abi.decodeFunctionResult(method, await rpc.request('eth_call', [{ to: target, data: abi.encodeFunctionData(method) }, block]))[0]; }
        catch { candidate.aggregatorProbes[method] = { unverified: true }; }
      }
    }
    const report = { network: 'ethereum', chainId: 1, block: snapshot.number, blockHash: snapshot.hash, source, assets,
      liveCapabilitiesApproved: false, note: 'Metadata matches and raw getter observations only. Multiple feeds, API labels and calculated variants require source/multiplier/status review. No candidate is selected or approved.' };
    mkdirSync('backups/equity-fork', { recursive: true });
    writeFileSync('backups/equity-fork/ethereum-ondo-feed-candidates.json', JSON.stringify(report, null, 2));
    console.log(`Read-only Ethereum discovery: ${candidates.length} candidates for ${assets.length} canonical assets; none approved. Report: backups/equity-fork/ethereum-ondo-feed-candidates.json`);
  } catch { console.error('Candidate discovery incomplete; verify directory/RPC access. No fallback or registry changes.'); process.exitCode = 1; }
  finally { if (rpc) await rpc.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
