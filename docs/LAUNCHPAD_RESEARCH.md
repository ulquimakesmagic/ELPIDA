# Launchpad research and locked-liquidity decision

**11 October decision:** locked liquidity belongs after virtual-curve graduation. The direct-pool recommendation below is historical. Use [the current specification](VIRTUAL_CURVE_AND_PAIRS.md): separate USDC fee, native/USDC pairing, then locked-pool graduation.

Reviewed 10 October 2026 using the official sources linked below. The user selected a locked liquidity pool during this review. Documented protocol features are observations; Elpida integration priorities are recommendations. No third-party mainnet deployments were executed or independently audited here.

## Comparison

| Protocol | Documented mechanics | Useful Elpida integration | Compatibility consideration |
| --- | --- | --- | --- |
| [Pons](https://docs.ponsfamily.com/) | Robinhood Chain token launches directly into a locked WETH Uniswap v3 pool; graduation is a milestone in the same pool. Fee split is snapshotted per launch. Current creator/protocol split is 70/30. | Pool-lock proof, immediate pool trading, fixed fee recipients and event-based indexing | WETH quoting and two-asset LP fees differ from Elpida's USDC quoting and 50/50 split |
| [Pump](https://pump.fun/docs/fees) | SOL and USDC bonding-curve trades currently charge 1.25%; creator 0.30%, protocol 0.95%. Graduated canonical pools have different schedules. Holder rewards can replace creator fees. | Quote-denominated accounting, distinct venue fee disclosure, holder reward allocation | Matching total fee does not mean matching fee recipients; its curve-to-PumpSwap lifecycle differs from the selected direct-pool model |
| [Raydium LaunchLab](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/launchlab/creator-fees.mdx) | Curve creator vault, CPMM creator fees and locked-LP Fee Keys are separate rights. Updated migration rules combine creator/platform LP scales into platform-owned locked LP. | Separate claimable fee streams and record actual beneficiaries | Do not promise a creator Fee Key from a historical configuration field. Verify current deployed program and pool settings |
| [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc) | Configurable quote asset and virtual pool followed by DAMM v2 migration; launch fees and lifecycle allocations are configurable | Solana launch templates, pool SDKs, LP locks and explicit fee ownership | DBC is a migration model. For direct pools, assess DAMM v2 independently instead of copying the DBC lifecycle |
| [Bags](https://docs.bags.fm/how-to-guides/launch-token-non-sol-quote) | Custom-quote DBC launches support shared fee recipients, with the same Fee Share configuration continuing after DAMM v2 graduation. Quote admission and live launch availability are separate checks | Multiple reward recipients, identity resolution, staged transaction plans and quote allowlists | An external integration brings its own configuration, administrator admission and economics; it cannot silently preserve Elpida's exact terms |

The source review covers five launch systems/infrastructure providers; it is not a ranking or security endorsement. Fees and deployed versions must be checked again before any integration.

## Selected Elpida model

Trading begins in a pool whose liquidity principal cannot be removed by the creator or protocol. There is no separate bonding-curve phase or migration requirement. Keep the agreed 10 USDC creation fee, mandatory creator first buy and 1.25% trade fee split 50/50 unless explicitly changed.

Production recommendation: established chain-native DEX pools with independently reviewed liquidity lockers. On EVM, assess a Uniswap v3-compatible position and immutable locker; on Solana, assess direct Meteora DAMM v2 positions and their supported lock mechanism. These are separate chain adapters, not one portable contract.

The implemented localhost/testnet prototype is a **custom real-reserve constant-product pool**, not Uniswap v3 or Meteora. It requires a separate creator-funded quote deposit, creates no redeemable LP token and exposes no liquidity removal, owner, upgrade or rescue function. All launch supply enters the pool before the first buy. Fee balances are accounted separately; claims send only those balances to immutable recipients.

That prototype is useful for testing the product flow and invariants, but it does not prove a production DEX integration. Pons-style single-sided concentrated liquidity can have different funding requirements and price behavior. A real two-sided constant-product pool needs quote liquidity. Never label virtual reserves as locked USDC.

The default form example costs 135 test USDC: 10 fee + 100 permanently deposited liquidity + 25 first buy. The deposit affects initial pricing, not just launch cost. Trading changes reserves; locking does not guarantee value, stable price or an exit. No admin removal path also means accidentally sent assets have no recovery path in this prototype.

## Integration priorities

| Priority | Feature | Concrete acceptance criterion |
| --- | --- | --- |
| First | Lock verification | Show pool/position, locker, chain, lock policy and explorer links from verified on-chain state; disable claims of locked liquidity if verification fails |
| First | Launch cost and price review | Separate fee, liquidity principal, first buy and network costs; show initial price and estimated token allocation |
| First | DEX and locker adapter | Confirm deployed contracts, atomic pool creation/lock/first buy, fee rights and failure rollback; remove owner principal-withdrawal and upgrade escape paths |
| First | Durable indexing | Index factory launches, pool trades, lock events and fee claims with reorg handling and per-chain finality |
| Next | Shared creator fees | Immutable/versioned recipient allocations totaling 100%; proofs for identity claims; immutable accrued entitlements |
| Next | Holder rewards | Explicit fee funding, eligibility rules, exclusion of pool/burn/treasury addresses, manipulation controls and claim/distribution accounting |
| Next | Wallet onboarding and USDC routing | Follow the companion wallet architecture; prove failed route and failed destination transaction recovery |
| Later | Launch protection | Test bounded early-buy policies and compatibility with routers; do not market per-wallet limits as bot-proof |
| Later | Community takeover | Explicit consent/governance and delay; separate social edits from fee-recipient rights; preserve accrued rights |
| Later | Additional quote assets | Admit individual assets after reviewing token behavior, decimals, issuer and pool compatibility |

Buybacks, stock-linked rewards and broad custom pairs add substantial economic/execution dependencies. Keep them out of the first locked-pool release. An external pool's trading fees do not automatically become Elpida's USDC creator fees; establish actual collectable fee rights and disclose conversion costs where applicable.

## Verification required before production

Test real DEX position ownership and locking, unauthorized NFT transfers, principal withdrawal attempts, collection to fixed recipients, out-of-range positions, callback authorization, reentrancy, fee-on-transfer rejection, slippage/deadlines, pool front-running and launch rollback. Check deployment licensing, audits, permissions and exact network addresses. Preserve the legacy curve prototype as reference, rather than rewriting already deployed contracts.
