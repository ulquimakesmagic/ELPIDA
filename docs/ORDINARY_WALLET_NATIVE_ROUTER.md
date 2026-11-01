# Ordinary-wallet native router — Sepolia rehearsal

Zerion reported no atomic wallet-batch capability after the ETH/tNVDAon conversion pool was funded. This router composes conversion and a token trade inside one contract transaction, so ordinary EVM wallets can use the native selection. A buy is one transaction. A sell can require a bounded ERC-20 approval first, followed by one atomic trade. Approving a sell and then cancelling/reverting the trade can leave that bounded allowance; no tokens are deposited by the approval.

## Deployment and use after this PR is deployed

1. Select **Ethereum Sepolia** and connect the usual EVM wallet with the top wallet button.
2. Open **Network and test funds → Deploy ordinary-wallet native router**. This is a single contract deployment, using test gas only, with no deposit. The UI and wallet method reject other chains/mainnet for this phase.
3. Deployment uses the existing receipt-resume helper. The browser verifies the exact creation transaction data and constructor arguments, successful creation receipt, resulting address/code, chain ID and immutable contract getters. A matching record is retained per chain/factory in this browser. Share the router address and creation hash afterward so they can be pinned for other visitors; the contract is ownerless and usable by any account.
4. Open STKTEST, select **ETH** and request a small quote, initially **0.0001 test ETH**. Review and approve the buy. Then sell a small token amount back to ETH. Funds and intermediates go only to the calling wallet. Extra pair assets from a capped buy return to that wallet.
5. Verify receipts, balances, trade attribution and zero temporary router approvals. The previous conversion-liquidity setup's one-raw-unit approval cleanup remains a separate pending action.

## Constraints and guards

- Immutable launch factory, curve deployer, SwapRouter02, V3 factory and wrapped native. No administrator, upgrade, arbitrary-call entrypoint, recipient override, rescue function or router fee.
- Factory Model 10 token/curve authentication uses the immutable deployer's CREATE addresses: token at odd nonce, curve at the next even nonce. Both must match, factory registration must exist, and curve factory/model/quote getters must agree. This is specific to the existing deployer that creates exactly token+curve per launch; future incompatible deployers require a new integration.
- Standard non-native pairs only. The existing curve is used before graduation; its genuine V3 pool is used afterward. Native-paired tokens retain their existing direct path. V2 tax routes, V1-style PancakeSwap routers and Solana are not part of this rehearsal.
- Conversion pool and graduated pool are resolved through the fixed V3 factory. User minimums protect both legs; deadline and positive amounts/minimums are mandatory. The native UI keeps its existing fixed 1% per-hop quote protection.
- Reentrancy protection, safe bounded approvals cleared inside the trade, exact token input checks, balance-delta accounting, and unused-input refunds. Pre-existing token/quote/wrapped-native donations cannot be swept by another caller. ETH is accepted only from the wrapped-native contract outside a buy.
- Failed conversion, trade, graduation, output minimum or recipient payment reverts the entire trade. Issuer transfer restrictions and the curve's stock-graduation checks still apply. A recipient rejecting ETH cannot strand a partly completed sell.
- Browser proof lookup is bounded to the first 2047 launches per factory for this test phase. The contract accepts uint64 CREATE nonces; scalable indexed proofs for larger histories are future work. Only one verified factory/router deployment is selected at a time; older factories are not silently redirected.

## Fees and indexing

No extra router fee or allocation change. On-curve Model 10 fees remain 1.25% at base, split 50/50 for a non-partner launch. Existing launch protection and partner buybacks remain in their contracts. After migration, the curve fee stops and the existing market pool fee applies. The separate native/pair conversion pool has its own DEX fee (the test pool is 0.3%).

The indexer attributes router market events to the wallet only when a same-transaction `NativeTrade` event from the market's recipient/seller matches the token, curve, side and exact token amount, together with a matching token Transfer to/from that wallet. Missing or ambiguous settlement proof is ignored. Quoted price/cost basis remains the underlying pair execution; the native conversion fee and gas are excluded from that basis and are not silently called token execution costs.

## Evidence

Local real-V3 tests cover ordinary-wallet buy/sell before and after graduation, exact 50/50 base-fee allocation, CREATE proof boundaries, wrong proofs/deployments, zero minimums, expired deadlines, failed-final-hop rollback, preservation of unrelated balances, approval cleanup, partially filled completing buys and locked graduation LP, native-recipient rejection/reentrancy, actual browser wallet methods, and spoof-resistant trade attribution. The existing indexer replay/reorg tests also pass.

Read-only Sepolia preflight on 1 November 2026 confirms the current factory deployer is `0xcf539Ad67a6Ae5C0F4F137Ca0D188DfDa6B3dF60`; STKTEST's curve proof is nonce **4** and derives token `0xc717BBd54d052FF45AFC73578b8e340D99541c11`. Constructor gas estimation against the current factory/DEX succeeds. No public router deployment or native STKTEST trade has been sent for this PR. No mainnet actions or real funds.

Validation: the full-suite checkpoint passed **644 tests**, with **33 intentional skips** and no failures (677 total). After the final provider-reconnect guard and regression test, the focused router, native conversion, public signer and web-shell run passed **20/20**, with no skips or failures. Router verification is repeated when the public read provider changes.

## Public Sepolia evidence — 1 November 2026

- Router `0xDDCc87C34eD8D8bEB6D5fAFc6C14e7cE8578fd41` deployed in `0x2843b435316c72830356f414bab1bd6b4ed6a77ae951a08f9ac05db9cd75eb61`, block 12041511, successful receipt. Exact creation data was verified against the deployed build artifact and immutable constructor configuration.
- Ordinary-wallet native buy `0xb5256e299f415fc5e6b056550da19923a0eeb07dd5d2810a83180aef5fd03451`, block 12041918, succeeded: **0.001 test ETH → 558707.153679830635398185 STKTEST** delivered to `0xf5B0cE04241f9518dfA3CBfbaafC7E40638E639D`. Gas used 633874. `NativeTrade` settlement matches the token delivery. The public index attributes it to the actual wallet, with the router-settlement proof recorded.
- Post-buy router STKTEST, tNVDAon and WETH balances and temporary approvals to the curve/swap router are all zero.
- Earlier buy `0xfcfb8bafc1439d9691d0493489b0e4f69cd170e72bbe807fc23d44b8a155feac` reverted after its deadline; replay confirmed `amount/minimum/deadline`. Purchase principal was not spent; gas was charged.
- Still open: public native sell rehearsal; shared router registration for other browsers; the earlier one-raw-unit liquidity-manager approval cleanup. No mainnet actions or real funds.

The accompanying CSS fix keeps the complete Ethereum diamond inside a circular badge, including when that image is used as token artwork. Verified locally in a 390px-wide swap fixture: both image bounds are 24×24 with `object-fit: contain`. Other uploaded artwork retains cover behavior. Web-shell checks: 3/3 passed; `git diff --check` clean.
