# Launching on the other EVM testnets (21 October 2026)

Base Sepolia proved the contract logic. Each other chain still needs its own setup checked: the graduation DEX, the
router layout, the price feed and the wrapped native coin. This is the order, chosen so no testnet coin is spent on
something that would fail.

| Chain | Graduation DEX | Router layout | Price feed | Status |
|---|---|---|---|---|
| Base Sepolia | Uniswap v3 | SwapRouter02 (v2) | Chainlink ETH/USD | Live, A2 to A5 done |
| Ethereum Sepolia | Uniswap v3 (addresses from Uniswap sdk-core) | SwapRouter02 (v2) | Chainlink ETH/USD `0x694A…5306` | Live, A2 to A5 done |
| BNB Chain Testnet | PancakeSwap v3 (addresses from pancake-v3-contracts) | original v3 SwapRouter (v1) | Chainlink BNB/USD `0x2514…7526` | Live, A2 to A5 done |
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

## Status (23 Oct)

| Chain | Fork check | Model 10 | Team launchpad (`shared`) | A2 to A5 live |
|---|---|---|---|---|
| Ethereum Sepolia | PASS 13/13, block 11965619 | On | `0xD641…6d2`, block 11972040 (22 Oct); setup txs below | **Done 22 Oct** (VEGETA, below) |
| BNB Testnet | **PASS 13/13 (23 Oct)**, block 138477356 via publicnode (PancakeSwap v3, router v1) | On | `0x8c48…fBbE`, block 138485798 (23 Oct); setup below | **Done 23 Oct** (MIDORIYA, below) |
| Robinhood Testnet | No DEX or feed | Off | | |

Until a chain's team launchpad is pinned in `packages/core/networks.mjs`, its launches show only in the deploying
browser, and token details are not staged (they would expire unindexed). After pinning, the public indexer lists them.

### Ethereum Sepolia setup (22 Oct, Malik's wallet `0xf5B0…639D`)

| Step | Transaction | Block | Result |
|---|---|---|---|
| Graduation adapter (WETH) | `0xf3921e4fd6de1840558a3798cec15e35446d896e14083763735c9f555a7ad934` | 11972038 | `0xf3a249e1abf044bee5324d02b99ee0fecb34d887` |
| Atomic factory | `0xdad271f4bd4dbb7e7e66054c3e14389a8733c31bfcba93669667daa039282be9` | 11972040 | `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2` |
| USD pricing activated | `0x3cb7ffeccfab605142eb9a8b27bb3635ae4a479f4457b9b37d11912538361ee3` | 11972044 | |
| USDC adapter | `0x8854e4305d4584dce73486e7afb65f595d59f5754bb681dd59ba7b87843e48dc` | 11972045 | `0xfaf81e4a0624d7fabf39bcbd011cf2259d01790c` |
| USDC pair approved | `0x3f5b3b0d506da4f604a222f434fd4fc3351dffa15917d4ce9a36b612f4cb39f7` | 11972046 | |
| First launch, VEGETA, with a 0.05 ETH creator buy | `0xdff8182721ac50bf1d8b6c758159103709620a9604e7bd565b474581edba48b3` | 11972076 | token `0x824932198c224e52a5b73e8c412e2987ef9b03a4`, curve `0x267629dda69505ac233fc92b3d7a4b09d6933924`; 754.0M of the 759.7M sale cap bought |

The same factory address as an old Base Sepolia launchpad is expected: the deployer's nonce matched on both chains.

VEGETA end to end (reported by Malik, 22 Oct):

| Check | Transaction |
|---|---|
| Final buy completed the curve and graduated it into Uniswap v3 in the same transaction (A2) | `0x0a8706affadcf063e3e7b6c829ccbf7fad8a685e0a3fb04bab6a1ead17d1009a` |
| Sell after graduation (A3) | `0x1d56d92660211de82f7a532e7b3219d7c536e4dc78ec06ee503f56f39fa76329` |
| Fee claim (A5) | `0x6cbd0da943bdd2e0ed85e68598da056d2b4f7b18463366d7c83adaab3a693faa` |

It ran smoothly; the feedback was too many confirmations for sells and claims, addressed in `WALLET_CONFIRMATIONS.md`.

### BNB Testnet setup (23 Oct, Trust Wallet, `0xf5B0…639D`)

Zerion cannot send transactions on BNB testnet (its own service answers 404), so the setup used Trust Wallet.
The first attempt read through `bsc-testnet-dataseed`, which Malik's network could not even resolve
(`ERR_NAME_NOT_RESOLVED`), and stopped after step 1. The site now reads BNB through publicnode.

| Step | Transaction | Result |
|---|---|---|
| Graduation adapter (WBNB) | `0xd0f67ea9d1d055a7c76ce66aded35b70912958e47777994e85dae69f45ed1e8f`, then `0xa5557614a0c27e0c22fc0290189b79a9860bb9fee0cca97d34fdf45de2ff7060` on retry | `0xD64119914DDA7b206d01Fb2B334A630Ca94fD6d2` in use |
| Atomic factory (requires token details on-chain) | `0x7b0cefee34089772dbf5d698f72da1c66608e7be5a66fe08f22f1fe299d7247f` (block 138485798) | `0x8c48b67E3D541955ec5DCf99629c4270aC6CfBbE` |
| USD pricing activated | `0xce6dc1d636a7c059aee6284ffe11744cdc56ef47461266404e504bdbbe3392f5` | confirmed ("Oracle pricing is already fixed" on retry) |

On BNB the graduation adapter has the same address as the Ethereum Sepolia factory: same deployer, same nonce.

MIDORIYA end to end (23 Oct). Malik reported the hashes; Claude read each receipt from the BNB testnet RPC.

| Check | Transaction | Block | What the receipt shows |
|---|---|---|---|
| Launch with token details on-chain | `0xa4d033c16fe988d3d4e39d526e5bc91e8d6a0cc5d0e7858df9bce9019150b26b` | 138493545 | `Launched` and `MetadataPublished` in the launch transaction; token `0xf7aa1a19ed16573f8dba8ef46a16c56703b433a4`, curve `0xb5955ca4a026f033bb062a3572324bdef72cc2a6` |
| Final buy completed the curve and graduated it into PancakeSwap v3 in the same transaction (A2) | `0x9919cfb1a274d307ed72d3c0615eb8ec6d5adbb8116dcb1b2e8ce72d9382a8f6` | 138495097 | 0.112774 tBNB in. `CurveCompleted`, PancakeSwap pool `0x7f186f7a2b9577fc2f8f69f14637f7ca847e3179` created and initialised, full-range mint, `Migrated`, position #39190 locked in locker `0x1d26eed604b92d1364ea807692db9006b2c6fcfd`. The token page then shows trading on PancakeSwap at about $500 market cap (10× the $50 start) |
| Fee claim in one confirmation (A5) | `0xc7abaeb1223a5e70c54e15aa66d688be9c03c5009f89b7c1094eea8c5c4baf57` | 138495267 | One Multicall3 transaction: curve `FeesWithdrawn`, pool `Burn` and `Collect`, locker `PositionFeesCollected` |
| Sell on the pool after graduation (A3) | `0xf566d91c20b63a41b3f548d8cfb024ca9b405bca469e57cc551b7b9d180f4a63` | 138503521 | Through PancakeSwap's v1 router `multicall`: 189,936,731.66 MIDORIYA in, 0.070571 WBNB out of pool `0x7f18…3179` (PancakeSwap `Swap` event), unwrapped to tBNB in the same transaction |

A second MIDORIYA launch (`0xf9541ad9523e4af4e03d1a861b8c2c8b9afbbd39918949de621a867bb2581bb3`, token
`0x7c7e935069048d541433b59a0512a1bdae041559`) is still trading on its curve.

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
