// Diagnostic read-only observations. Observed code pins and example risk limits never install a live policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Interface, keccak256 } from 'ethers';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';
import { readChainlinkQuoteUsd } from './lib/ondo-quote-usd.mjs';
import { readOndoV3Twap } from './lib/ondo-v3-twap.mjs';

const source = 'https://reference-data-directory.vercel.app/feeds-mainnet.json';
let proxy;
try {
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error();
  const feed = (await response.json()).find(f => f.path === 'usdc-usd' && f.proxyAddress?.toLowerCase() === '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6');
  if (!feed || feed.decimals !== 8 || !Number.isSafeInteger(feed.heartbeat) || feed.heartbeat < 1 || feed.heartbeat > 86400) throw new Error();
  const rpc = process.env.ELPIDA_EQUITY_FORK_RPC_ETHEREUM ?? process.env.ELPIDA_EQUITY_FORK_RPC;
  const snapshot = await forkSnapshot(rpc, 1, process.env.ELPIDA_EQUITY_FORK_BLOCK);
  proxy = await createForkRpc({ rpc, snapshot, cacheDir: 'cache/equity-rpc' });
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  const iface = new Interface(['function aggregator() view returns(address)']);
  const [aggregator] = iface.decodeFunctionResult('aggregator', await proxy.request('eth_call', [{ to: feed.proxyAddress, data: iface.encodeFunctionData('aggregator') }, block]));
  const observedHash = async address => keccak256(await proxy.request('eth_getCode', [address, block]));
  const policy = { network: 'ethereum', token: '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee',
    quoteToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', quoteDecimals: 6,
    quoteFeed: feed.proxyAddress, quoteAggregator: aggregator, quoteFeedId: 'ethereum-usdc-usd-diagnostic',
    quoteFeedCodeHash: await observedHash(feed.proxyAddress), quoteAggregatorCodeHash: await observedHash(aggregator),
    quoteFeedDecimals: feed.decimals, quoteDescription: feed.name, quoteMaxAgeSec: feed.heartbeat,
    // Diagnostic only: no production policy ID, reference feed or execution-depth approval.
    maxAgeSec: feed.heartbeat, minTwapWindowSec: 600, minHarmonicLiquidity: '1',
    pool: '0xc9b4bc7c15423fcfe6b75ab5118ba773945a3a46', factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', fee: 3000 };
  policy.poolCodeHash = await observedHash(policy.pool); policy.factoryCodeHash = await observedHash(policy.factory);
  const quoteUsd = await readChainlinkQuoteUsd({ policy, snapshot, request: proxy.request });
  const twap = await readOndoV3Twap({ asset: { provider: 'ondo', network: 'ethereum', address: policy.token, decimals: 18 }, policy, snapshot, quoteUsd, request: proxy.request });
  const report = { scope: 'READ ONLY: historical/diagnostic observations, not an approved oracle or market policy', network: 'ethereum', chainId: 1,
    block: snapshot.number, blockHash: snapshot.hash, source, directoryHeartbeatSec: feed.heartbeat,
    cappedFeed: feed.docs?.stablecoinCapped === true, diagnosticPolicy: policy, quoteUsd, twap,
    marketUsable: false, liveCapabilitiesApproved: false,
    unresolved: ['Ethereum stock total-return reference and corporate-action/status source', 'Reviewed venue, freshness and liquidity risk limits', 'Bidirectional executable reserve-sized quotes and participant restrictions', 'Issuer and jurisdiction eligibility'] };
  mkdirSync('backups/equity-fork', { recursive: true });
  const path = 'backups/equity-fork/ethereum-ondo-NVDAon-market-observations.json';
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`Read-only quote-USD and 600s pool TWAP observed at block ${snapshot.number}; market remains UNVERIFIED. Report: ${path}`);
} catch { console.error('Market observation failed: no feed, dollar-peg or spot-price fallback. Check source availability, block and feed/pool history.'); process.exitCode = 1; }
finally { if (proxy) await proxy.close(); }
