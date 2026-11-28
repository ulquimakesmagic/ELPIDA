# Elysium HYPE/USD oracle and treasury setup

## Oracle

The [Chainlink HyperEVM directory](https://reference-data-directory.vercel.app/feeds-hyperliquid-mainnet.json) lists HYPE/USD at `0x2b25BC41D55de29F3A2e163F8Eebf63966B25b57`, with 18 decimals, a 24-hour heartbeat and 0.5% deviation. The on-chain proxy returned a complete, current round. A HYPE/USD contract published for Elysium itself was not confirmed in the [Pyth directory](https://docs.pyth.network/pro/contract-addresses) or the other oracle sources checked.

`ElpidaHypeUsdPublisher` reads that proxy on HyperEVM (999) and submits a [retryable ticket](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/l1-to-l2-messaging) through the canonical Elysium Inbox `0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff`. The live HyperEVM gateway's `inbox()` points to that address. Its bridge is `0x503D572157113fAaaD4DbeD2647Bb10b949216B6`, the allowlist is disabled, and the Inbox is unpaused at the checked block.

`ElpidaElysiumHypeUsdFeed` accepts the original round only from the publisher's protocol-defined alias on Elysium (99901). Its price, Chainlink round number and observation timestamp come from the source proxy. Anyone can pay for a delivery. The source, Inbox, receiver and authorized publisher are fixed at deployment. Both contracts reject nonpositive, incomplete, future-dated or older-than-one-day rounds. The receiver also rejects duplicate and out-of-order rounds. A delayed or missed delivery can prevent price-dependent launches until a fresh source round arrives.

On a HyperEVM fork at block `52357979`, the canonical Inbox accepted the publisher's ticket. The message carried the original source round `18446744073709570731` and timestamp `1795753719`. On a separate Elysium fork at block `11386588`, the locally simulated bridge sender delivered that round and the receiver returned the same tuple. The local receiver and factory test covers delivery authentication, expiry, the USD launch fee and the virtual quote.

## First mainnet delivery

The publisher is `0x84B5af2d2fa874833838Ad0BF7bAEaDA075A129A`. The receiver is `0x29f0D2A8F2DD5B2dF872222f10bE35D6B27aFD71`. Its authorized sender is the publisher's Elysium alias `0x95C6aF2D2FA874833838Ad0Bf7bAEADa075a23aB`. [Publisher deployment](https://hyperevmscan.io/tx/0x38ec200687946624d3272e703e24917f1cee478005e1df2d5d275479452710cc) · [Receiver deployment](https://elysiumexplore.com/tx/0x6756f2c15a00f6e4e914a96e56a7265b420c74f5156c0f4938a01ab7c296519a)

On 28 November 2026, the Inbox accepted ticket `2663624` at HyperEVM block `52426435`. Elysium redeemed it at block `11867100`, nine seconds later by block timestamps. The receiver returned the same five fields as Chainlink at the submission block, including round `18446744073709570789`, the `$63.3207` answer and observation timestamp `1795822525`. [HyperEVM receipt](https://hyperevmscan.io/tx/0xdb2ae06d15bcd022655133c33bd486f4f50e6ce3564d884696d21e19d6ff7c88) · [Elysium receipt](https://elysiumexplore.com/tx/0xf63f04b5c32eb7c396afbc5afc43a42a1e8abcdf284814dc0d43c0c51bf390fb)

The HyperEVM transaction debited `0.000184473637360992 HYPE` before any Elysium refund. That includes `0.000171591137360992 HYPE` deposited with the ticket and `0.0000128825 HYPE` of HyperEVM gas. Elysium reported `0.0000678355 HYPE` of redemption gas, funded by the ticket. The authorized trial covered one delivery. Budget ongoing updates and set up monitoring before relying on the feed for public launches.

## Deployment and operations

1. Choose the two deployers on their respective networks. From the Elysium deployer's exact next nonce, compute the receiver address using `ethers.getCreateAddress`. Reserve that nonce for the receiver deployment. Deploy the HyperEVM publisher with the verified proxy, Inbox and predicted receiver address. Use the actual publisher address to deploy the Elysium receiver at the reserved nonce. Read all immutables back against the reviewed deployment record.
2. Estimate the retryable's submission fee through `calculateRetryableSubmissionFee` and the execution fee against the child chain. The ticket has zero child call value. The submitting wallet pays on HyperEVM and receives any applicable refund at its Elysium address. Re-read the fee quotes immediately before submitting.
3. Deliver one real round with Malik's explicit approval and confirm both receipts. Compare the Elysium `latestRoundData()` tuple to the Chainlink round at the HyperEVM submission block. Measure delivery latency and fees before setting the relay schedule. Check for a new source round every few minutes, watch the delivered round ID, and alert if delivery is delayed or the source observation nears expiry. A retry should check the ticket and target state before submitting again.
4. The [Elysium V2.3 plan](../deployments/plans/elysium-mainnet-v23.json) uses the verified receiver as `usdFeed`. The Safe batch sets the factory's `usdMaxAge` from the plan's `feedMaxAge` of 86,400 seconds. The deployment requires confirmed Elysium keeper and guardian addresses and approval for the completed plan. Rehearse a native launch, buy and sell with the configured treasury. USDC payout routing and xStocks have their own launch gates.

The plan uses the [published Uniswap v4 PoolManager](https://developers.uniswap.org/docs/protocols/v4/deployments#elysium-99901) and the six-decimal [bridged USDC](ELYSIUM_XSTOCK_CANDIDATES.md) mapped to Circle USDC on HyperEVM.

## Native V2.3 fork rehearsal

An Anvil fork pinned at Elysium block `11867100` used the deployed oracle and treasury Safe with test keeper and guardian wallets. The deployment and all seven wiring checks passed after applying the Safe batch by impersonating the treasury on the fork. A native launch opened at `$20,014.78` after tick rounding. The guardian paused new launches and the existing pool still completed a native HYPE buy and full sell. Both trades ran during the opening fee window. They used 240,699 and 137,881 gas respectively.

The five contract deployments used 9,726,490 gas on the fork. The draft budgets 12 million gas with a 0.01 HYPE minimum deployer balance. Recheck the balance and fee quote immediately before deployment.

## Safe on Elysium

The [Safe Config Service](https://safe-config.safe.global/api/v1/chains/99901) returned 404 for Elysium. The [Safe deployment registry](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0) lists these canonical contracts. Their runtime code hashes matched the registry on chain 99901.

| Safe v1.5.0 component | Address |
| --- | --- |
| Safe L2 singleton | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` |
| Proxy factory | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` |
| Compatibility fallback handler | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` |
| MultiSendCallOnly | `0xA83c336B20401Af773B6219BA5027174338D1836` |

The Elysium treasury Safe is `0x99654F654450F0e070Bf62ee2566005b69d54428`. It uses the canonical Safe v1.5.0 singleton and a 2-of-3 threshold across the confirmed HyperEVM treasury owners. Its setup used a zero call target, empty call data and zero setup payment. [Safe creation receipt](https://elysiumexplore.com/tx/0xa1103f98af74cad4fdaf617855896ef36ad98747a3e3761ce1b3636ba0dafd64)

On an Elysium fork at block `11386153`, the canonical factory deployed this setup with test signers and the Safe executed a zero-value MultiSend batch with two EIP-712 signatures. [Safe Protocol Kit](https://docs.safe.global/sdk/protocol-kit) can collect and execute two signatures against the Elysium RPC.
