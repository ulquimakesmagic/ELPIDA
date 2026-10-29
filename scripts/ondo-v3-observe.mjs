// Read-only venue reconnaissance. A discovered pool is not an approved price feed or launch venue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Interface, keccak256 } from 'ethers';
import { forkSnapshot, createForkRpc } from './lib/equity-fork-rpc.mjs';
import { consultV3 } from './lib/ondo-v3-twap.mjs';
import assert from 'node:assert/strict';

const factory = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const [pool = '0xc9b4bc7c15423fcfe6b75ab5118ba773945a3a46', window = '600'] = process.argv.slice(2);
const windowSec = Number(window);
const abi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)',
  'function factory() view returns(address)', 'function getPool(address,address,uint24) view returns(address)', 'function observe(uint32[]) view returns(int56[],uint160[])']);
let proxy;
try {
  assert.match(pool, /^0x[0-9a-f]{40}$/i);
  assert.ok(Number.isInteger(windowSec) && windowSec >= 30 && windowSec <= 86400);
  const registry = JSON.parse(readFileSync(new URL('../config/tokenized-equity-registry.json', import.meta.url), 'utf8'));
  const asset = registry.assets.find(a => a.network === 'ethereum' && a.provider === 'ondo' && a.symbol === 'NVDAon');
  const rpc = process.env.ELPIDA_EQUITY_FORK_RPC_ETHEREUM ?? process.env.ELPIDA_EQUITY_FORK_RPC;
  const snapshot = await forkSnapshot(rpc, 1, process.env.ELPIDA_EQUITY_FORK_BLOCK);
  proxy = await createForkRpc({ rpc, snapshot, cacheDir: 'cache/equity-rpc' });
  const block = { blockHash: snapshot.hash, requireCanonical: true };
  const call = async (to, method, args = []) => abi.decodeFunctionResult(method, await proxy.request('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, block]));
  const [token0] = await call(pool, 'token0'), [token1] = await call(pool, 'token1'), [fee] = await call(pool, 'fee');
  assert.ok([token0, token1].some(a => a.toLowerCase() === asset.address.toLowerCase()));
  assert.equal((await call(pool, 'factory'))[0].toLowerCase(), factory);
  assert.equal((await call(factory, 'getPool', [token0, token1, fee]))[0].toLowerCase(), pool.toLowerCase());
  const [ticks, secondsPerLiquidity] = await call(pool, 'observe', [[windowSec, 0]]);
  const observation = consultV3({ ticks, secondsPerLiquidity, windowSec });
  const report = { scope: 'READ ONLY: raw pool observations, no approved USD price or execution', network: 'ethereum', chainId: 1,
    block: snapshot.number, blockHash: snapshot.hash, pool, token: asset.address, token0, token1, fee: Number(fee), windowSec,
    factory, poolCodeHash: keccak256(await proxy.request('eth_getCode', [pool, block])),
    factoryCodeHash: keccak256(await proxy.request('eth_getCode', [factory, block])),
    ticks: ticks.map(String), secondsPerLiquidity: secondsPerLiquidity.map(String), ...observation,
    harmonicMeanLiquidity: observation.harmonicMeanLiquidity.toString(), usdPrice: null, liveCapabilitiesApproved: false,
    source: 'https://raw.githubusercontent.com/Uniswap/sdk-core/main/src/addresses.ts',
    note: 'Pool wiring/history observed, not an independent audited feed, adequate USD depth, issuer eligibility or future fill.' };
  mkdirSync('backups/equity-fork', { recursive: true });
  const path = `backups/equity-fork/ethereum-ondo-NVDAon-${pool.toLowerCase()}-twap.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`Observed ${windowSec}s window at Ethereum block ${snapshot.number}: mean tick ${observation.floorTick}, harmonic liquidity ${observation.harmonicMeanLiquidity}. USD pricing remains UNVERIFIED. Report: ${path}`);
} catch { console.error('Observation failed: verify pool wiring, archive access and available history. No spot-price fallback or live approval.'); process.exitCode = 1; }
finally { if (proxy) await proxy.close(); }
