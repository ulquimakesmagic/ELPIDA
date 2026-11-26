# HyperEVM Ondo stock candidates

The [Ondo contract registry](https://docs.ondo.finance/addresses) listed these 35 Global Markets tokens for HyperEVM (999) on 26 November 2026. At block `52332396`, each token returned the published name and symbol, 18 decimals, and the shared compliance address recorded in the candidate list. Each entry includes its explorer address. Ondo describes the bridge as a [LayerZero multi-asset OFT](https://docs.ondo.finance/tools/ondo-bridge).

`config/stocks/candidates/hyperevm-ondo.json` is a research input. Its prices are unset. No matching HyperEVM stock feeds were confirmed in the Chainlink directory or the Pyth and RedStone resources checked. The Ondo registry did not identify a HyperEVM synthetic shares oracle. An adapter needs a verified local price and the token's adjustment multiplier before it can quote USD per token. The standard priced list build rejects these null feeds.

A 0.1 HYPE HyperSwap v3 sample did not return a direct or USDC-hop quote for NVDAon, SPYon, or TSLAon. Conversion availability remains open and needs a chain-specific route and usable depth per pair.

After the public native HYPE launch, buy, and sell pass, rehearse a stock-quoted launch, buy, and sell on an Anvil fork. Record transfer behavior through the factory, hook, PoolManager, and router. Validate the HYPE conversion, apply Ondo eligibility and the stock region block, and run the full suite before proposing an active list. Malik reviews the list and authorizes any quote approvals through the treasury Safe.
