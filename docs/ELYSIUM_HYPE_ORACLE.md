# Elysium HYPE/USD oracle and treasury setup

## Oracle

The [Chainlink HyperEVM directory](https://reference-data-directory.vercel.app/feeds-hyperliquid-mainnet.json) lists HYPE/USD at `0x2b25BC41D55de29F3A2e163F8Eebf63966B25b57`, with 18 decimals, a 24-hour heartbeat and 0.5% deviation. The on-chain proxy returned a complete, current round. A HYPE/USD contract published for Elysium itself was not confirmed in the [Pyth directory](https://docs.pyth.network/pro/contract-addresses) or the other oracle sources checked.

`ElpidaHypeUsdPublisher` reads that proxy on HyperEVM (999) and submits a [retryable ticket](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/l1-to-l2-messaging) through the canonical Elysium Inbox `0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff`. The live HyperEVM gateway's `inbox()` points to that address. Its bridge is `0x503D572157113fAaaD4DbeD2647Bb10b949216B6`, the allowlist is disabled, and the Inbox is unpaused at the checked block.

`ElpidaElysiumHypeUsdFeed` accepts the original round only from the publisher's protocol-defined alias on Elysium (99901). Its price, Chainlink round number and observation timestamp come from the source proxy. Anyone can pay for a delivery. The source, Inbox, receiver and authorized publisher are fixed at deployment. Both contracts reject nonpositive, incomplete, future-dated or older-than-one-day rounds. The receiver also rejects duplicate and out-of-order rounds. A delayed or missed delivery can prevent price-dependent launches until a fresh source round arrives.

On a HyperEVM fork at block `52357979`, the canonical Inbox accepted the publisher's ticket. The message carried the original source round `18446744073709570731` and timestamp `1795753719`. On a separate Elysium fork at block `11386588`, the locally simulated bridge sender delivered that round and the receiver returned the same tuple. The local receiver and factory test confirms delivery authentication, expiry and the USD launch fee and virtual quote. A public ticket still needs to prove end-to-end delivery and establish an operating budget.

## Deployment and operations

1. Choose the two deployers on their respective networks. From the Elysium deployer's exact next nonce, compute the receiver address using `ethers.getCreateAddress`. Reserve that nonce for the receiver deployment. Deploy the HyperEVM publisher with the verified proxy, Inbox and predicted receiver address. Use the actual publisher address to deploy the Elysium receiver at the reserved nonce. Read all immutables back against the reviewed deployment record.
2. Estimate the retryable's submission fee through `calculateRetryableSubmissionFee` and the execution fee against the child chain. The ticket has zero child call value. The submitting wallet pays on HyperEVM and receives any applicable refund at its Elysium address. Re-read the fee quotes immediately before submitting.
3. Deliver one real round with Malik's explicit approval and confirm both receipts. Compare the Elysium `latestRoundData()` tuple to the Chainlink round at the HyperEVM submission block. Measure delivery latency and fees before setting the relay schedule. Check for a new source round every few minutes, watch the delivered round ID, and alert if delivery is delayed or the source observation nears expiry. A retry should check the ticket and target state before submitting again.
4. Only after that proof, put the Elysium receiver address in the launchpad plan as `usdFeed`, with `feedMaxAge` and `usdMaxAge` set to 86,400 seconds. Run the V2.3 native launch, buy and sell rehearsal with the verified Safe. USDC payout routing and xStocks have their own launch gates.

## Safe on Elysium

The [Safe Config Service](https://safe-config.safe.global/api/v1/chains/99901) returned 404 for Elysium. The [Safe deployment registry](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0) lists these canonical contracts. Their runtime code hashes matched the registry on chain 99901.

| Safe v1.5.0 component | Address |
| --- | --- |
| Safe L2 singleton | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` |
| Proxy factory | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` |
| Compatibility fallback handler | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` |
| MultiSendCallOnly | `0xA83c336B20401Af773B6219BA5027174338D1836` |

The shared Elpida treasury address still has no code on Elysium. Its Arbitrum creation used an initializer with a delegate call. Use a fresh Elysium 2-of-3 Safe with confirmed signers, a zero setup call target, empty setup data and zero setup payment. On an Elysium fork at block `11386153`, the canonical factory deployed this setup with test signers and the Safe executed a zero-value MultiSend batch with two EIP-712 signatures. [Safe Protocol Kit](https://docs.safe.global/sdk/protocol-kit) can use the Elysium RPC and manage the two signatures without the hosted app. Rehearse the actual Safe setup and the V2.3 wiring batch before approving deployment. Verify the deployed Safe's singleton, owners and threshold before using its new address as `treasury`.
