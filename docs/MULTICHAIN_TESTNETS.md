# Launching on the other EVM testnets (21 October 2026)

Base Sepolia proved the contract logic. Each other chain still needs its own setup checked: the graduation DEX, the
router layout, the price feed and the wrapped native coin. This is the order, chosen so no testnet coin is spent on
something that would fail.

| Chain | Graduation DEX | Router layout | Price feed | Status |
|---|---|---|---|---|
| Base Sepolia | Uniswap v3 | SwapRouter02 (v2) | Chainlink ETH/USD | Live, A2 to A5 done |
| Ethereum Sepolia | Uniswap v3 (addresses from Uniswap sdk-core) | SwapRouter02 (v2) | Chainlink ETH/USD `0x694A…5306` | Configured, waiting for its fork check |
| BNB Chain Testnet | PancakeSwap v3 (addresses from pancake-v3-contracts) | original v3 SwapRouter (v1) | Chainlink BNB/USD `0x2514…7526` | Configured, waiting for its fork check |
| Robinhood Chain Testnet | none confirmed on testnet | — | none confirmed on testnet | Not possible yet; our contracts were checked against Robinhood **mainnet** Uniswap on a fork |

## PancakeSwap differences found and fixed before any deployment

PancakeSwap v3 is a Uniswap v3 fork. Two differences would have broken BNB graduations, confirmed from
`@pancakeswap/v3-core` 1.0.2 and `@pancakeswap/v3-periphery` 1.0.3:

1. `slot0().feeProtocol` is `uint32` (two packed 16-bit fees, real values far above 255); Uniswap declares `uint8`.
   The adapter reads `slot0` on **every** graduation, so the old declaration would have reverted on BNB. Now `uint32`,
   which still decodes Uniswap's values (`tests/pancake-compat.test.mjs`).
2. Pools call `pancakeV3SwapCallback`, not `uniswapV3SwapCallback`. The adapter's rebalance of a pre-created pool needs
   it. Both names now share one guarded implementation.
3. PancakeSwap's periphery router uses the original layout: the deadline is inside the swap, and `multicall(bytes[])`
   has no deadline. `packages/core/dex-router.mjs` encodes both layouts; the wallet picks one per network.

## Status (22 Oct)

| Chain | Fork check | Model 10 | Team launchpad (`shared`) | A2 to A5 live |
|---|---|---|---|---|
| Ethereum Sepolia | PASS 13/13, block 11965619 | On | Not yet: deploy, then send the factory address and block | Open |
| BNB Testnet | Steps 1 to 4 PASS on 22 Oct; step 5 lost upstream state (`missing revert data` = the RPC failed, not a revert). Rerun with the archive-first RPC choice | Off | | |
| Robinhood Testnet | No DEX or feed | Off | | |

Until a chain's team launchpad is pinned in `packages/core/networks.mjs`, its launches show only in the deploying
browser, and token details are not staged (they would expire unindexed). After pinning, the public indexer lists them.

## Order

1. **Collect test coins** (faucets have daily limits):
   - Ethereum Sepolia about 0.2 ETH: QuickNode (no mainnet balance needed), the Sepolia PoW faucet, Chainlink, Google Cloud.
   - BNB Testnet about 0.3 tBNB: bnbchain.org testnet faucet, the official Telegram bot @bnbchain_official_bot (0.3 a day), QuickNode.
2. **Run the fork check on your PC** (free, local only, nothing is sent to the chain):
   ```
   cd C:\Users\HomePC\Desktop\OneForAll\elpida-fork
   git checkout main
   git pull
   npm.cmd run test:chain-fork -- ethereum-sepolia
   npm.cmd run test:chain-fork -- bnb-testnet
   ```
   Each prints 13 checks and PASS or FAIL, and writes `backups/chain-fork/<network>.json` with the gas of every step
   and how much to collect at today's gas price. Forking needs an RPC that still holds recent state. Public BNB nodes
   prune it within seconds (error `missing trie node`), so the check tests several public RPCs first, forks one block
   behind the head of the first good one, and retries on another if state disappears mid-run. If all of them fail,
   use a free archive RPC (NodeReal MegaNode, dRPC, QuickNode or Chainstack) for that one command. The check now tries
   OnFinality's public BNB endpoint first (it advertises archive data) and prints the real cause behind
   "missing revert data", which ethers shows for any RPC failure during gas estimation:
   `$env:ELPIDA_FORK_RPC_BNB_TESTNET="https://…"` (PowerShell). The key stays in your terminal; never commit it.
3. **Switch the chain on** (Claude, one small PR per chain): set `enabled: true` in `testnetDexes` with the report attached.
4. **Deploy the launchpad** from the app: Network and funds → switch to the chain → set up the launchpad. It deploys
   the graduation adapter and the factory and activates USD pricing.
5. **Repeat A2 to A5 on that chain** (checklist A7): one launch, completion and graduation, a DEX buy and sell, a claim.

## TEST-STOCK end to end (Base Sepolia, can run any time)

Tokenized-stock pairs use the labelled test asset; real stocks stay off.
1. Network and funds (as the launchpad owner) → **Add test xStock and token pairs** (six confirmations, gas only).
2. Use the TEST-STOCK faucet (250 per claim) and launch a token paired with TEST-STOCK.
3. Buy until the curve completes (about 48 TEST-STOCK at test size); it graduates into a TEST-STOCK/token Uniswap pool.
4. Buy and sell on the pool, then claim fees. Send the transaction hashes to record the evidence.
