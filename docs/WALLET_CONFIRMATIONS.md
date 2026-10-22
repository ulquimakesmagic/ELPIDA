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

Approvals were exact (only the amount of this trade) until 22 October; see the update below for selling launched tokens.

## Update, 22 October: one confirmation without a batching wallet

Testing on Ethereum Sepolia with Zerion (no EIP-5792 batches), sells still took two confirmations and claims several.

| Flow | Any wallet, from 22 Oct |
|---|---|
| EVM fee claim | **1 transaction** through Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, the same contract on nearly every EVM chain) whenever the chain has it; otherwise as in the table above |
| Selling a launched token (curve or DEX) | 2 the **first** time for that token (approve once, then sell), **1** for every later sell |
| Paying with USDC, an xStock or a paired token | unchanged: exact approval per trade (1 with batching wallets, 2 without) |

Why these are safe:
- **Claims:** every step (`withdrawFees`, `collectFees`, `claim`) is callable by anyone and pays only the fixed
  recipients, so running them from Multicall3 changes nothing but the number of transactions. The app checks that
  Multicall3's code exists on the chain first. `tests/one-confirmation.test.mjs` runs curve fees, pool fees and
  every claim in one Multicall3 transaction on a real local chain, and again with nothing owed.
- **Sells:** the curve's `sell` and the DEX routers pull tokens only from `msg.sender`, so a standing approval of the
  launched token can be used only by its holder. This is the same trade-off the Uniswap app makes. Valuable payment
  assets keep exact approvals. An approval can be revoked from the token's explorer page or a revoke tool.

The first sell of each token still shows two confirmations because ERC-20 approvals must come from the holder and
these tokens have no `permit`. Wallets that batch get one confirmation there too.

## Why batching a claim is safe

The batch is all or nothing, so every step must succeed when it has nothing to do. On-chain, `withdrawFees` with
nothing owed returns, `collectFees` with nothing to collect returns zeros, and `claim` with nothing claimable returns
quietly. `tests/wallet-steps.test.mjs` proves this on a graduated curve.

## Which wallets batch

Batching is used only when the wallet reports `atomic: supported` for the chain (`wallet_getCapabilities`). Coinbase
Wallet / smart wallets do; MetaMask does once the account is upgraded to a smart account; others fall back to
separate, labelled steps. The capability check runs once per wallet and network, and never for a single step.

Not changed: the tax-market flows (`tax-wallet.mjs`, disabled on public networks) still send steps separately.
