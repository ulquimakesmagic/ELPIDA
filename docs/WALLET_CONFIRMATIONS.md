# Wallet confirmations (21 October 2026)

Before this change, an EVM trade that needed an approval asked for **two** signatures (approve, then trade) every time,
and a fee claim after graduation asked for up to **four** (`withdrawFees` on the curve, `collectFees` on the locker, then
one splitter `claim` per asset). Seen on Base Sepolia with SONGOKU: claim txs `0xabba0cc5…`, `0x10d1d79c…`, `0x3aa3a139…`,
`0x3950759d…`.

## Now

| Flow | Wallet supports atomic batches (EIP-5792 `wallet_sendCalls`) | Wallet does not |
|---|---|---|
| Curve buy/sell needing an approval | **1** confirmation (exact approval + trade, atomic) | 2, labelled "Step 1 of 2 …" |
| Uniswap buy/sell needing an approval | **1** (exact approval + swap) | 2, labelled |
| Trade with enough allowance already, or a native buy | 1 | 1 |
| EVM fee claim after graduation | **1** (all steps in one batch) | only the steps that move money: the curve step is skipped when nothing is owed, the collect is skipped when a read-only dry run shows nothing to collect, and splitter claims are sent only when something is or will be claimable |
| Solana curve fees + PumpSwap LP harvest | **1** transaction when it fits and simulates (checked without signing) | otherwise 2, as before |
| Launch | already 1 with batching wallets (unchanged) | unchanged |

Approvals stay **exact** (only the amount of this trade); no unlimited approvals were introduced.

## Why batching a claim is safe

The batch is all or nothing, so every step must succeed when it has nothing to do. On-chain, `withdrawFees` with
nothing owed returns, `collectFees` with nothing to collect returns zeros, and `claim` with nothing claimable returns
quietly. `tests/wallet-steps.test.mjs` proves this on a graduated curve.

## Which wallets batch

Batching is used only when the wallet reports `atomic: supported` for the chain (`wallet_getCapabilities`). Coinbase
Wallet / smart wallets do; MetaMask does once the account is upgraded to a smart account; others fall back to
separate, labelled steps. The capability check runs once per wallet and network, and never for a single step.

Not changed: the tax-market flows (`tax-wallet.mjs`, disabled on public networks) still send steps separately.
