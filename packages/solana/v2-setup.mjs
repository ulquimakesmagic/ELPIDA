// ELPIDA V2 on Solana, step 4a: sets up what the upgraded program needs before anyone can launch a V2 token.
//  - the V2 SOL pair (`add_v2_config`): the ×5 curve, the 1.00% minimum fee (the only one the mainnet build accepts),
//    90% anti-snipe over 60 s and the 3% first-buy cap; then USD pricing on it from the verified Pyth SOL/USD account
//    (the $10 fee, and the starting market cap: $50 on test networks, $20,000 on mainnet);
//  - the two reward distributors (`init_v2_distributor`): the trader airdrop in calendar months from the first of the
//    current month, holder rewards weekly from today (UTC), both run by the server keeper's Solana key.
// Idempotent: anything already in place is read back and left as it is (distributors are immutable once created).
import * as web3 from '@solana/web3.js';
import { createElpidaSolana, curveParams, WSOL_MINT, V2, V2_DIST } from './client.mjs';
import { ensurePricing, send } from './deploy.mjs';

const { PublicKey } = web3;
const DAY = 86_400;
/** Starting market cap in USD (6 decimals) for V2 SOL pairs: test size on test clusters, the spec's $20,000 on mainnet. */
export const V2_START_FDV_USD_E6 = Object.freeze({ mainnet: '20000000000', devnet: '50000000', localnet: '50000000' });

/** First of the current UTC month and today's UTC midnight, in unix seconds. */
export function v2Genesis(nowSecs) {
  const d = new Date(nowSecs * 1000);
  return { month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000, today: nowSecs - nowSecs % DAY };
}

/** Curve parameters of the V2 SOL pair. `startFdvSol` only sizes the fallback curve; USD pricing resizes it per launch. */
export function v2SolParams({ startFdvSol, launchFeeSol }) {
  const start = Number(startFdvSol);
  return curveParams({ startFdv: String(start), endFdv: String(start * 5), quoteDecimals: 9, launchFee: launchFeeSol, baseFeeBps: V2.mainnetMinFeeBps, snipeStartBps: V2.snipeStartBps, snipeWindowSecs: V2.snipeWindowSecs, maxCreatorBuyBps: V2.firstBuyCapBps });
}

/**
 * Creates (or reads back) the V2 SOL pair and the two distributors. `keeper`: the server keeper's Solana address
 * (the distributors' operator). `oracle`: SOLANA_ORACLES[cluster] (null leaves the fixed SOL fee). Returns the record
 * the deploy script publishes as `v2`.
 */
export async function ensureV2({ connection, payer, programId, treasury, cluster, keeper, oracle, pricing, onProgress = () => {} }) {
  if (!keeper) throw new Error('ELPIDA V2 needs the server keeper\'s Solana address (--keeper). Create it with node scripts/solana-keeper-key.mjs.');
  const client = createElpidaSolana(web3, programId), wsol = new PublicKey(WSOL_MINT), operator = new PublicKey(keeper);
  const config = client.configV2For(wsol);
  if (!await connection.getAccountInfo(config)) {
    onProgress('Creating the ELPIDA V2 SOL pair (1.00% minimum fee, ×5 curve, 3% first-buy cap)…');
    await send(connection, payer, [client.computeBudget(), client.addV2Config({ authority: payer.publicKey, quoteMint: wsol, treasury: new PublicKey(treasury), params: v2SolParams({ startFdvSol: pricing.startFdv, launchFeeSol: pricing.launchFee }) })]);
  } else onProgress('ELPIDA V2 SOL pair already exists.');
  const decoded = client.decodeConfig((await connection.getAccountInfo(config)).data);
  if (decoded.modelVersion !== 4) throw new Error(`${config.toBase58()} is not a V2 config.`);
  let usdPricing = null;
  if (oracle) {
    const v2Oracle = { ...oracle, startFdvUsdE6: V2_START_FDV_USD_E6[cluster] ?? oracle.startFdvUsdE6 };
    const result = await ensurePricing({ connection, payer, programId, config: config.toBase58(), oracle: v2Oracle, onProgress: m => onProgress(`V2 pair: ${m}`) });
    usdPricing = { priceAccount: v2Oracle.priceAccount, feeUsdE6: v2Oracle.feeUsdE6, startFdvUsdE6: v2Oracle.startFdvUsdE6, created: result.created };
  }
  const now = await connection.getBlockTime(await connection.getSlot('confirmed')) ?? Math.floor(Date.now() / 1000);
  const { month, today } = v2Genesis(now);
  const distributors = {};
  for (const [name, kind, period, genesis] of [['airdrop', V2_DIST.airdrop, 0, month], ['holder', V2_DIST.holder, 7 * DAY, today]]) {
    const address = client.v2DistPda(kind);
    let info = await connection.getAccountInfo(address);
    if (!info) {
      onProgress(`Creating the ${name === 'airdrop' ? 'trader airdrop (monthly)' : 'holder rewards (weekly)'} distributor, run by ${operator.toBase58()}…`);
      await send(connection, payer, [client.initV2Distributor({ authority: payer.publicKey, kind, operator, period, genesis })]);
      info = await connection.getAccountInfo(address);
    }
    const d = client.decodeV2Distributor(info.data);
    if (!d.operator.equals(operator)) onProgress(`Note: the ${name} distributor is run by ${d.operator.toBase58()}, not ${operator.toBase58()} (distributors are immutable).`);
    distributors[name] = { address: address.toBase58(), vault: client.distVault(kind).toBase58(), operator: d.operator.toBase58(), period: d.period, genesis: d.genesis };
  }
  return {
    config: config.toBase58(), quoteMint: WSOL_MINT, treasury: decoded.treasury.toBase58(), minFeeBps: decoded.baseFeeBps, maxFeeBps: V2.maxFeeBps,
    curve: { virtualQuote: decoded.virtualQuote.toString(), virtualToken: decoded.virtualToken.toString(), curveSupply: decoded.curveSupply.toString() },
    usdPricing, distributors, flywheelVault: client.v2VaultPda('flywheel').toBase58(), keeper: operator.toBase58(),
  };
}
