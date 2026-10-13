# Scope and security blockers

Historical status below is retained for reference. For the current Base model-9 implementation and release gates, use [Base mainnet review](BASE_MAINNET_REVIEW.md).

**11 October model:** separate USDC launch fee, native/USDC virtual curves, and graduation into a locked custom test pool. Direct-pool launch entries below are historical. Production DEX adapters and the updated Solana program are pending; see [current specification](VIRTUAL_CURVE_AND_PAIRS.md).

## Implemented prototype
- Default UI: real-reserve pool with permanently locked principal, atomic seeding/first buy, separately claimable fixed-destination fees; custom test pool, not a production DEX integration
- EVM ERC-20 fixed-supply token
- EVM factory collects 10 USDC launch fee and executes mandatory positive first buy atomically
- EVM virtual-reserve bonding curve with buy/sell and 125 bps trading fee
- 50/50 protocol/creator reward accounting, paid to an external creator vault address
- Node reference math and unit tests
- Pinned Solidity compiler and local EVM integration tests, including launch rollback and mixed-trade reserve/inventory checks
- Draft database schema
- Responsive localhost launchpad UI and loopback-only development API
- Browser-wallet deployment and trading flow on Base Sepolia, Ethereum Sepolia, BNB Chain Testnet and Robinhood Chain Testnet (public-network execution needs a funded wallet)
- Quote-decimals-aware factory (6-decimal Circle USDC and 18-decimal BNB Chain USDC)
- Testnet-only Elpida tUSDC with a capped public faucet for chains without Circle test USDC
- Solana Anchor locked-pool program (launch with fee + locked deposit + first buy, buy, sell, permissionless fee payout), devnet deploy script, Phantom/Solflare browser flow, and validator-based tests

## Not implemented (must not be marketed as functional)
- Solana token metadata (Metaplex/Token-2022) and branded vanity mint generation
- Creator allocation registry and identity verification
- Holder snapshots and automatic reward distributions
- Automatic token/tokenized-stock purchases and distribution
- Cross-chain unified USDC vault/bridging/settlement
- Third-party DEX pool/position creation and production liquidity locker (direct pool model has no required graduation)
- Stock/other-token custom quote pairs
- Production backend, persistent indexing and monitoring (current API is local development only)
- Mainnet deployment scripts and integration tests against actual target-chain infrastructure (Solana has a devnet deploy script only)

## Critical risks to address before deployment
- Prototype curve is not audited or economically calibrated. Model reserve insolvency, dust, MEV, front-running and slippage.
- Fee accounting is in the quote asset; 0.625% each can differ by a single atomic unit due to rounding.
- Quote asset must be allowlisted and validated as a trusted USDC deployment (6–18 decimals supported); reject fee-on-transfer and rebasing tokens. Elpida tUSDC must never be deployed or accepted on mainnet.
- External creator vault is currently a simple address, not an implemented distribution engine.
- Factory and curve compile and have deterministic local integration/invariant checks. Adversarial token, property-based, fuzz and target-chain testing are still required.
- No user funds should be deposited or deployed to mainnet from this prototype.
- Automatic payouts require permissionless epoch verification, gas budgets, replay-safe batch progress, and compliance checks for restricted tokenized stocks.
- External DEX trades are not automatically charged the platform fee.
- The Solana program is upgradeable by the deployer keypair (`local-data/solana-deployer.json`). Before any real-asset use, move the upgrade authority to a multisig or make the program immutable, and keep the program keypair (`contracts/solana/keys`) private.
- The Solana program is unaudited; it relies on Anchor account constraints, classic SPL Token quote mints (no Token-2022 transfer fees) and checked arithmetic. Fuzzing and an independent review are still required.
- A unified cash balance needs robust on-chain accounting, settlement finality, idempotency, custody review and chain-specific gas management.
