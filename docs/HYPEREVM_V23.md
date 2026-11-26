# HyperEVM V2.3 native HYPE rehearsal

26 November 2026. `deployments/plans/hyperevm-mainnet-v23.json` stages chain 999 with native HYPE, Circle USDC, and the standard Chainlink HYPE/USD proxy. The site requires a separately published ready deployment record. The production treasury must first be set up and verified as a Safe.

An Anvil fork at block **52,332,308** used a temporary Safe and test wallets. V2.3 deployment and wiring verified, the native launch started at about $20,004 after tick rounding, and the guardian stop worked. With new launches stopped, a native HYPE buy delivered tokens and selling the full position returned native HYPE. The buy used 239,311 gas and the sell used 136,561 gas. No transactions were sent to HyperEVM.

The factory used **3,079,559 gas** and the hook **3,998,931 gas**. The public RPC reported a 3 million gas limit on an observed small block. Configure the real deployer for big blocks through HyperCore before deployment and use the current big-block fee to estimate funding. The plan's **0.025 HYPE** balance floor is provisional. It excludes separate Safe and keeper funding.

HyperSwap v3 is the candidate payout venue. Check the wrapped HYPE and Circle USDC addresses, router and quoter wiring, quote depth at the intended amounts, and a full conversion rehearsal before enabling rewards. The existing Elpida quoter returned a live quote at the 0.3% tier for 0.1 HYPE.

Before publishing a ready record, finish Safe setup, pass live preflight, complete the owner-approved deployment and Safe batch, configure the server RPC, and pass a native HYPE launch, buy, and sell. Stock pairs follow separately after this smoke test. HyperEVM uses Ondo stocks. Elysium follows with Backed xStocks after its own native HYPE smoke test. Arbitrum and Arc have no stock pairs in this phase.

Sources: [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments#hyperevm-999), [Chainlink HYPE/USD feed](https://docs.chain.link/data-feeds/price-feeds/addresses?network=hyperevm&page=1&search=HYPE&showSvr=true), [Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses), [HyperSwap v3 contracts](https://docs.hyperswap.exchange/docs/amm/contracts/hyper-evm/v3/), [HyperEVM block modes](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture), [Safe on HyperEVM](https://safe.global/blog/hyperliquid-and-the-safe-standard-the-future-of-defi).
