// Browser entry for PumpSwap trading on Elpida token pages, bundled to apps/web/vendor/pumpswap.mjs by
// scripts/build-pumpswap-vendor.mjs. It uses PumpSwap's official SDK (@pump-fun/pump-swap-sdk, MIT), so the account
// lists, fee schedule and wrapped-SOL handling match the deployed program. @solana/web3.js is NOT bundled: it is the
// page's own copy (window.solanaWeb3), so keys and instructions are the same classes the wallet code uses.
import BN from 'bn.js';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';

export const SDK = '@pump-fun/pump-swap-sdk@2.2.0';

async function prepare({ connection, pool, user, side, amount, slippageBps }) {
  if (side !== 'buy' && side !== 'sell') throw new Error('Choose buy or sell.');
  const state = await new OnlinePumpAmmSdk(connection).swapSolanaState(pool, user);
  const slippage = Number(slippageBps) / 100; // the SDK takes percent
  const amountBn = new BN(String(amount));
  // The same inputs the SDK's own buyQuoteInput / sellBaseInput pass, so the shown quote is what gets sent.
  const common = {
    slippage, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves, quoteTransferFee: state.quoteTransferFee,
    globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount, baseMint: state.baseMint,
    coinCreator: state.pool.coinCreator, creator: state.pool.creator, feeConfig: state.feeConfig,
    quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode, creatorFeeBps: state.pool.creatorFeeBps,
  };
  if (side === 'buy') {
    // The swap buys an exact token amount and may charge up to `maxQuote` (the amount plus slippage).
    const q = buyQuoteInput({ quote: amountBn, ...common });
    return { state, slippage, amountBn, out: big(q.base), limit: big(q.maxQuote), fee: big(amountBn) - big(q.internalQuoteWithoutFees) };
  }
  const q = sellBaseInput({ base: amountBn, ...common, feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees) });
  return { state, slippage, amountBn, out: big(q.uiQuote), limit: big(q.minQuote), fee: big(q.internalQuoteAmountOut) - big(q.uiQuote) };
}
const big = bn => BigInt(bn.toString());

/**
 * What a PumpSwap trade returns, read from the chain now. side 'buy': `amount` is the quote (SOL lamports or USDC
 * units) to spend, `out` the tokens received and `limit` the most the trade may charge. side 'sell': `amount` is raw
 * tokens, `out` the quote received after fees and `limit` the minimum accepted. `slippageBps`: 100 = 1%.
 */
export async function pumpSwapQuote(args) {
  const { out, limit, fee } = await prepare(args);
  return { out, limit, fee };
}

/** The quote plus the instructions to sign (wrapping and unwrapping SOL, creating the token account, the swap). */
export async function pumpSwapTrade(args) {
  const p = await prepare(args);
  const instructions = args.side === 'buy'
    ? await PUMP_AMM_SDK.buyQuoteInput(p.state, p.amountBn, p.slippage)
    : await PUMP_AMM_SDK.sellBaseInput(p.state, p.amountBn, p.slippage);
  return { instructions, out: p.out, limit: p.limit, fee: p.fee };
}
