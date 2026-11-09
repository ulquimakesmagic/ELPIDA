// ELPIDA V2.0 trading indexer: V2 launches (ElpidaV2Hook / ElpidaV2Factory) listed and traded on the site like Model 11
// ones. The pool mechanics are Model 11's, so V4Indexer reads them; this class supplies V2's ABIs, its per-token fee and
// its five-way fee ledgers. Test networks only until the V2 contracts are audited.
import { Contract, formatUnits, getAddress } from 'ethers';
import { V4Indexer, V4_ABIS, v4Slot0 } from './v4-indexer.mjs';
import { ratio } from './evm-indexer.mjs';
import { supplyPercent } from '../core/curve-model.mjs';
import { V4_FLAG_MASK, V4_HOOK_FLAGS, grossForNet, v4PoolState, v4Price } from '../core/v4-model.mjs';
import { V2_MODEL, V2_MODEL_VERSION, V2_SNIPE_START_BPS, V2_SNIPE_WINDOW_SECONDS, V2_FEE_SPLIT } from '../core/v2-economics.mjs';

const dead = '0x000000000000000000000000000000000000dead';
const RECIPIENTS = ['creator', 'traderAirdrop', 'flywheel', 'holderRewards', 'treasury'];

export const V2_ABIS = Object.freeze({
  factory: ['event Launched(address indexed creator,address indexed token,address indexed quote,uint256 feeBps,uint256 firstBuy,uint256 bought)', 'event MetadataPublished(address indexed token,string uri)', 'event QuoteApproved(address indexed asset,uint256 virtualQuote)', 'event HookSet(address indexed hook)',
    'function MODEL_VERSION() view returns(uint256)', 'function hook() view returns(address)', 'function feeUsdc() view returns(address)', 'function treasury() view returns(address)', 'function startMcapUsd() view returns(uint256)'],
  hook: ['event Launched(address indexed token,address indexed quote,address indexed creatorVault,uint256 feeBps,int24 upperTick,int24 lowerTick,uint128 saleLiquidity,uint128 upperLiquidity,uint256 dustBurned)',
    'event Fee(address indexed token,address indexed trader,bool buy,uint256 feeBps,uint256 fee,uint256 lockedBonus)',
    'event Milestone(address indexed token,uint256 saleQuote,uint256 bonus,uint128 liquidity,uint256 dust,uint256 tokensBurned)',
    'event FeesWithdrawn(address indexed token,uint8 indexed recipient,address to,uint256 amount)', 'event FeePayoutFailed(address indexed token,uint8 indexed recipient,address to,uint256 amount)',
    'function launchOf(address) view returns(address quote,address creatorVault,uint64 launchedAt,uint16 feeBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 liquidityBonus,uint128 accrued)',
    'function liquidityOf(address) view returns(uint128 sale,uint128 upper,uint128 milestone)', 'function ledgers(address) view returns(uint256[5] owed,uint128[5] paid)',
    'function currentFeeBps(address) view returns(uint256)', 'function factory() view returns(address)', 'function protocolTreasury() view returns(address)', 'function minFeeBps() view returns(uint256)'],
  pool: V4_ABIS.pool, router: V4_ABIS.router,
  token: [...V4_ABIS.token, 'function burn(uint256)'],
});

export class V2Indexer extends V4Indexer {
  constructor(options) { super({ ...options, abis: V2_ABIS }); }

  async launchFields(address, factoryEvent, hookEvent, call) {
    const launch = await this.hookContract.launchOf(address, call), feeBps = Number(hookEvent.args.feeBps);
    return { curveModel: V2_MODEL_VERSION, model: V2_MODEL, launchedAt: Number(launch.launchedAt), feeBps,
      feeSchedule: { base: feeBps, start: V2_SNIPE_START_BPS, window: V2_SNIPE_WINDOW_SECONDS }, poolFeeBps: feeBps, buybackBps: 0, feeSplit: V2_FEE_SPLIT };
  }

  async readSnapshot(r, height, block) {
    const call = { blockTag: height }, t = new Contract(r.address, this.abis.token, this.provider), d = r.quoteDecimals;
    const [l, liq, ledgers, slot, feeBps, supply, deadBalance, inPools, devHolding] = await Promise.all([this.hookContract.launchOf(r.address, call), this.hookContract.liquidityOf(r.address, call), this.hookContract.ledgers(r.address, call),
      v4Slot0(this.managerContract, r.poolId, call), this.hookContract.currentFeeBps(r.address, call), t.totalSupply(call), t.balanceOf(dead, call), t.balanceOf(this.poolManager, call), t.balanceOf(r.creator, call)]);
    const state = v4PoolState({ upperTick: Number(l.upperTick), lowerTick: Number(l.lowerTick), saleLiquidity: liq.sale, upperLiquidity: liq.upper, milestoneLiquidity: liq.milestone, graduated: l.graduated }, slot.sqrtPrice);
    const square = slot.sqrtPrice * slot.sqrtPrice, Q = 1n << 192n, circulating = supply - deadBalance - inPools;
    const graduated = l.graduated, bps = Number(feeBps), own = Number(l.feeBps);
    const owed = Object.fromEntries(RECIPIENTS.map((k, i) => [k, formatUnits(ledgers.owed[i], d)])), paid = Object.fromEntries(RECIPIENTS.map((k, i) => [k, formatUnits(ledgers.paid[i], d)]));
    return { pool: this.poolManager, poolId: r.poolId, graduated, complete: graduated, soldOut: false, liquidityLocked: true, liquidityOpen: false, venue: 'Uniswap v4', feeBps: bps, tokenFeeBps: own, antiSnipeActive: !graduated && bps > own,
      sqrtPriceX96: slot.sqrtPrice.toString(), tick: slot.tick, reserve: formatUnits(state.quoteReserve, d), reserveBasis: 'quote in the hook\'s locked positions (the PoolManager holds every v4 pool\'s funds together)', poolTokens: formatUnits(state.tokenReserve, 18),
      sold: formatUnits(state.saleSold, 18), saleCap: formatUnits(state.saleTokens, 18), supply: formatUnits(supply, 18), circulatingSupply: formatUnits(circulating, 18), deadSupply: formatUnits(deadBalance, 18), burnedSupply: formatUnits(1_000_000_000n * 10n ** 18n - supply, 18),
      spotPrice: v4Price(slot.sqrtPrice, d), fdvQuote: square ? ratio(Q * supply, square * 10n ** BigInt(d)) : null, circulatingMarketCapQuote: square ? ratio(Q * circulating, square * 10n ** BigInt(d)) : null,
      supplyPolicy: 'exclude PoolManager inventory; burns reduce totalSupply', priceUsd: null, usdBasis: null,
      creatorFees: owed.creator, protocolFees: owed.treasury, feeLedgers: { owed, paid }, accrued: formatUnits(l.accrued, d), feesBasis: 'unpaid shares of the token\'s fees, held as claims in the PoolManager', liquidityBonus: formatUnits(l.liquidityBonus, d),
      buybackBps: 0, milestoneLiquidity: liq.milestone.toString(),
      remainingBuy: graduated ? '0' : formatUnits(grossForNet(state.toMilestone, bps), d), remainingBase: graduated ? '0' : formatUnits(grossForNet(state.toMilestone, own), d),
      devHoldingRaw: devHolding.toString(), devHoldingPct: supplyPercent(devHolding, supply), indexedBlock: height, indexedBlockHash: block.hash, priceTimestamp: block.timestamp };
  }

  status() { return { ...super.status(), model: V2_MODEL, adapters: ['Elpida V2 hook', 'Uniswap v4 PoolManager', ...(this.router ? ['Elpida v4 router'] : [])] }; }
}

/** Reads a V2 deployment's wiring from the chain: factory ↔ hook, the hook's permission bits, the router's hook. */
export async function verifyV2Deployment(provider, { factory, hook, router, poolManager }) {
  const f = new Contract(factory, V2_ABIS.factory, provider), h = new Contract(hook, V2_ABIS.hook, provider);
  const [version, factoryHook, hookFactory] = await Promise.all([f.MODEL_VERSION(), f.hook(), h.factory()]);
  if (Number(version) !== V2_MODEL_VERSION || factoryHook.toLowerCase() !== hook.toLowerCase() || hookFactory.toLowerCase() !== factory.toLowerCase()) throw new Error('V2 deployment mismatch');
  if ((BigInt(getAddress(hook)) & V4_FLAG_MASK) !== V4_HOOK_FLAGS) throw new Error('Hook address lacks its permission bits');
  if (router) { const r = new Contract(router, V2_ABIS.router, provider), [rh, rm] = await Promise.all([r.hook(), r.poolManager()]); if (rh.toLowerCase() !== hook.toLowerCase() || rm.toLowerCase() !== poolManager.toLowerCase()) throw new Error('V2 router mismatch'); }
  return true;
}
