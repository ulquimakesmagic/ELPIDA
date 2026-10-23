# Launching on the other EVM testnets (21 October 2026)

Base Sepolia proved the contract logic. Each other chain still needs its own setup checked: the graduation DEX, the
router layout, the price feed and the wrapped native coin. This is the order, chosen so no testnet coin is spent on
something that would fail.

| Chain | Graduation DEX | Router layout | Price feed | Status |
|---|---|---|---|---|
| Base Sepolia | Uniswap v3 | SwapRouter02 (v2) | Chainlink ETH/USD | Live, A2 to A5 done |
| Ethereum Sepolia | Uniswap v3 (addresses from Uniswap sdk-core) | SwapRouter02 (v2) | Chainlink ETH/USD `0x694A…5306` | Live, A2 to A5 done |
| BNB Chain Testnet | PancakeSwap v3 (addresses from pancake-v3-contracts) | original v3 SwapRouter (v1) | Chainlink BNB/USD `0x2514…7526` | Live, A2 to A5 done |
| Robinhood Chain Testnet | none on testnet (23 Oct): Uniswap's official v3 deployment is on Robinhood **mainnet** (chain 4663) only | — | none confirmed on testnet | Not possible on testnet; our contracts were checked against Robinhood **mainnet** Uniswap on a fork. A fork check of mainnet's Uniswap and feed is the way to test it without funds |

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
| Robinhood Testnet | No DEX or feed on testnet. **Mainnet fork check PASS 14/14 (23 Oct)**, block 96216786 (`robinhood-mainnet`, below) | Off | | Not possible on testnet |

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

### Mainnet configuration (checklist D1, 23 Oct)

Malik's mainnet chains: Base, BNB Chain, Robinhood Chain and Ethereum. Each has a fork check that runs the whole
lifecycle against the chain's real DEX and feed on a local fork, with mainnet terms ($5,000 start). Nothing is sent and
no funds are used:

```
npm.cmd run test:chain-fork -- base-mainnet
npm.cmd run test:chain-fork -- bnb-mainnet
npm.cmd run test:chain-fork -- ethereum-mainnet
npm.cmd run test:chain-fork -- robinhood-mainnet
```

| Chain (id) | DEX, router layout | Factory | Position manager | Router | QuoterV2 | Wrapped native |
|---|---|---|---|---|---|---|
| Base (8453) | Uniswap v3, SwapRouter02 (v2) | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x2626664c2603336E57B271c5C0b26F421741e481` | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | `0x4200000000000000000000000000000000000006` |
| BNB Chain (56) | PancakeSwap v3, original layout (v1) | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` (read from the manager) |
| Robinhood Chain (4663) | Uniswap v3, SwapRouter02 (v2) | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `0xCaf681a66D020601342297493863E78C959E5cb2` | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Ethereum (1) | Uniswap v3, SwapRouter02 (v2) | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

| Chain | Chainlink feed (standard proxy) | Decimals | Heartbeat / deviation | Suggested `maxAge` at deployment |
|---|---|---|---|---|
| Base | ETH / USD `0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b` | 8 | 1200 s / 0.15% | 1500 s |
| BNB Chain | BNB / USD `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | 8 | 27 s / 0.1% | 120 s |
| Robinhood Chain | ETH / USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | 8 | 86400 s / 0.5% | 86400 s (the contract's maximum) |
| Ethereum | ETH / USD `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 8 | 3600 s / 0.5% | 3900 s |

Sources (read 23 Oct): Uniswap's v3 deployment pages for Base, Ethereum and Robinhood Chain; PancakeSwap's v3 address
page; Chainlink's price-feed address list per network, with "More Details" for heartbeat and deviation.

Notes:
- **`maxAge` is fixed when the treasury configures pricing (once).** Use the suggested value: about one heartbeat plus a
  margin. Too short and launches fail while the feed is healthy; too long and a stalled feed keeps pricing the fee.
- **Standard proxies, not SVR.** Chainlink also lists SVR proxies, which recapture liquidation MEV for lending
  protocols. Elpida only prices a $10 fee and a starting valuation, so the standard proxy is the plain choice. On BNB
  Chain one BNB / USD proxy reports 18 decimals; the contract reads `decimals()`, but the table uses the 8-decimal one.
- **USDC fee on BNB Chain:** USDC there is an 18-decimal bridged token, and `configureUsdPricing` accepts only a
  6-decimal fee asset, so BNB mainnet charges the $10 fee in BNB. USDC as a trading pair is separate (the factory scales
  to the quote's decimals) and still needs its address verified before approval.
- **PancakeSwap v3 is also on Robinhood Chain** (same factory address as BSC, its own position manager, no v3 router
  listed). Uniswap v3 stays the Robinhood choice because it has the router the app uses.
- **L2 sequencer:** Base and Robinhood Chain are rollups; see audit finding F-7.

**Results (23 Oct, Malik's PC), each 14/14 unless noted:**

| Chain | Result | Block, RPC | Fee priced at | Real deployment gas |
|---|---|---|---|---|
| Base | **PASS 14/14** | 53001266, mainnet.base.org (deep history) | 0.004168 ETH | 9,846,059 gas, about 0.000059 ETH at 0.006 gwei |
| Ethereum | **PASS 14/14** | 26258156, eth.drpc.org (deep history) | 0.004166 ETH | 9,848,558 gas, about 0.000497 ETH at 0.050 gwei |
| Robinhood Chain | **PASS 14/14** | 96216786, rpc.mainnet.chain.robinhood.com | 0.004174 ETH | 9,846,287 gas, about 0.000197 ETH |
| BNB Chain | **PASS 14/14** (second run) | 129399881, bsc-mainnet.public.blastapi.io (deep history) | 0.013509 BNB | 9,848,536 gas, about 0.00049 BNB at 0.05 gwei |

The first BNB run passed the DEX and feed checks on every attempt, then public nodes refused the fork's state reads
(publicnode 403, dataseed pruned, drpc rate-limited). With more BNB nodes, a 403 counted as retryable and six attempts,
the second run chose blastapi (deep history) and passed, through PancakeSwap's original router layout. If public
nodes refuse again, use a free archive key: NodeReal MegaNode, then
`$env:ELPIDA_FORK_RPC_BNB_MAINNET="https://bsc-mainnet.nodereal.io/v1/<key>"` (keep the key in the terminal only).

### Robinhood Chain: mainnet fork check (23 Oct)

Robinhood Chain's testnet cannot be tested live: Chainlink's feed list says "Robinhood Chain feeds are not available on
testnet", and Uniswap's official v3 deployment is on mainnet (chain 4663) only. So the lifecycle runs on a **local fork
of Robinhood mainnet** against its real Uniswap v3 and Chainlink ETH/USD feed. Mainnet state is only read; every
transaction happens on the fork, with Hardhat's test accounts. No wallet, key or funds are involved.

```
npm.cmd run test:chain-fork -- robinhood-mainnet
```

| Item | Address | Source |
|---|---|---|
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | Uniswap docs, Robinhood Chain v3 deployments |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | same |
| SwapRouter02 (router v2) | `0xCaf681a66D020601342297493863E78C959E5cb2` | same |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | same |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Uniswap sdk-core `WETH9[4663]`; re-read from the manager on the fork |
| Chainlink ETH / USD (standard proxy) | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | Chainlink price-feed addresses, Robinhood Chain Mainnet |

The run uses mainnet terms ($5,000 start, 24 h grace), allows the feed a 24 h age (crypto feeds on Arbitrum-based
chains have a 24 h heartbeat), and adds a 14th check that the feed's `description()` is `ETH / USD`. The other 13 are
the same as BNB and Ethereum Sepolia. RPC: `https://rpc.mainnet.chain.robinhood.com`; override with
`$env:ELPIDA_FORK_RPC_ROBINHOOD_MAINNET`.

**Result (23 Oct, Malik's PC): PASS 14/14** at Robinhood mainnet block 96216786, via `rpc.mainnet.chain.robinhood.com`
(deep history):
- Uniswap v3: the manager belongs to the factory, WETH matches, and the 1% tier has tick spacing 200.
- The feed is `ETH / USD`. The $10 fee priced at 0.004174 ETH (about $2,396 per ETH).
- The final buy graduated atomically into pool `0x214E…23CE`, and the position is held by the locker.
- A DEX buy through SwapRouter02 delivered tokens; a sell unwrapped ETH to the seller.
- Pool fees were credited from both trades; claims paid out and cleared.
- A pre-created pool was repriced at graduation.
- The indexer recorded both trades and both graduations.

A real deployment would use 9,846,287 gas: about 0.000197 ETH at that day's 0.020 gwei. Nothing was spent.

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
