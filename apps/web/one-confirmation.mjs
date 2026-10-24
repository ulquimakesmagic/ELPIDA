// One confirmation per action (22 Oct 2026).
// Claims: every fee step (curve withdrawFees, locker collectFees, splitter claim) is permissionless and pays only to
// fixed recipients, so the steps can go through Multicall3 as ONE transaction on any wallet, not only on wallets that
// batch (EIP-5792). Multicall3 is the same audited contract at the same address on nearly every EVM chain; the app
// checks that code exists there before using it and otherwise falls back to the previous behaviour.
// Sells: the curve and the DEX routers only ever pull tokens from the seller (msg.sender), so a standing approval of
// the launched token can be used by no one else. Approving it once removes the approval step from every later sell.
// Valuable assets people pay with (USDC, xStocks, paired tokens) keep exact per-trade approvals.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)'];
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Calldata for one Multicall3 transaction that runs every step in order and reverts if any step fails. */
export function multicallData(Interface, steps) {
  if (!steps.length) throw new Error('Nothing to send.');
  if (steps.some(s => (s.value ?? 0n) !== 0n)) throw new Error('Multicall steps cannot carry value.');
  return new Interface(MULTICALL3_ABI).encodeFunctionData('aggregate3', [steps.map(s => ({ target: s.to, allowFailure: false, callData: s.data }))]);
}

/**
 * The approval to request before a trade, or null if the allowance already covers it.
 * The launched token being sold is approved once (unlimited) for that market; anything else exactly for this trade.
 */
export function approvalFor({ allowance, input, sellingLaunchedToken, symbol = 'the token' }) {
  if (allowance >= input) return null;
  return sellingLaunchedToken
    ? { amount: MAX_UINT256, label: `Approve ${symbol} for selling here (once; later sells need one confirmation)…` }
    : { amount: input, label: 'Approve exactly this trade amount…' };
}

// Launches (23 Oct 2026). A wallet without batching (EIP-5792) needs an approval before a launch that pays in USDC or
// a paired token. The launchpad only ever pulls from the caller of its own launch (msg.sender), in the amounts that
// caller passes: the 10 USDC fee and the creator's first buy. So on testnets the asset is approved once for that
// launchpad and every later launch is one confirmation. Mainnet keeps exact approvals until the contracts are audited.

/** The approval to request before a launch, or null if the allowance already covers it. */
export function launchApproval({ allowance, needed, mainnet = false, symbol = 'USDC', exactLabel }) {
  if (allowance >= needed) return null;
  return mainnet
    ? { amount: needed, label: exactLabel ?? `Approve exactly this ${symbol} amount…` }
    : { amount: MAX_UINT256, label: `Approve ${symbol} for launches on this launchpad (once; later launches need one confirmation)…` };
}

/**
 * Waits until a confirmed approval is visible to the RPC the launch is estimated on. Load-balanced public RPCs can
 * answer from a node a few blocks behind; launching then fails, and a retry would read no allowance and ask again.
 */
export async function waitForAllowance(read, needed, { attempts = 12, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await read() >= needed) return;
    await sleep(1500);
  }
  throw new Error('The approval is confirmed, but the network has not caught up yet. Wait a few seconds and launch again; you will not be asked to approve again.');
}
