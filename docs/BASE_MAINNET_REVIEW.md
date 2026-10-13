# Base security review and release gates

Status: **not approved for mainnet**. This document supersedes the historical implementation status in SECURITY_AND_NEXT_STEPS.md. Internal inspection and passing tests are not an independent audit.

## Review scope

Review the current Solidity source and its dependency lockfile: ElpidaDexFactory, ElpidaUsdPricing, ElpidaDexCurve, ElpidaToken, ElpidaV3MigrationAdapter, ElpidaV3FeeLocker and ElpidaFeeSplitter. Include the browser wallet, batch recovery, metadata staging, price keeper, public indexer and API request policy in the application review. Older Beta/custom-pool contracts are compatibility code, not the proposed Base release.

Solidity is 0.8.24, optimizer enabled with one run, EVM target Shanghai; reproduce the exact build using npm ci and npm run compile. The source registry currently configures a Base Sepolia model-9 factory, not a Base mainnet deployment. Constructor arguments, oracle configuration, approved quotes and adapters are part of the review: source hashes alone cannot validate immutable deployment values.

## Implemented and verified

- Native $10-equivalent and 10-USDC fees are enforced by contracts, with round validity, maximum age and native refund checks. Native curves snapshot starting valuation at launch.
- Exact requested ERC-20 approvals; first-buy failures revert creation; metadata reference is authorized by the creation transaction on compatible Base deployments.
- Virtual curve buy/sell accounting, completion cap and graduation use deployed Uniswap v3 contracts on a Base Sepolia fork. JUICEWRLD fork graduation, swaps, claims and locked principal passed at block 48075531.
- The immutable locker retains the position NFT, exposes fee collection and has no principal withdrawal, rescue or upgrade function. Fixed beneficiaries receive collected fees in both pool assets.
- Railway testnet metadata uses persistent content-addressed storage. Public indexing uses SQLite and a confirmation depth. ELTEST's new on-chain metadata resolved publicly.
- Internal inspection found that legacy metadata/publish bypassed the new staging limit. Both now share the same per-process upload request limit. This is mitigation, not wallet authentication or a durable quota system.

## Required release gates

| Gate | Current evidence / missing work | Completion criterion |
| --- | --- | --- |
| Independent review | No independent audit delivered | Reviewer examines frozen source/build/deployment scope; findings are fixed and retested; residual risks are explicitly accepted |
| Adversarial economics | Deterministic tests and fork success exist | Property/fuzz campaigns cover solvency, rounding, fee-on-transfer/rebasing assets, reentrancy, hostile beneficiaries, pool price griefing and MEV; discovered cases become regressions |
| Public graduation | Fork passed; JUICEWRLD remains on curve | Funded public curve completes, graduates, indexes swaps/fees, and is verified from a fresh browser with successful recovery paths |
| Mainnet addresses | Registry/deployment flow is testnet-oriented | Validate chain 8453, canonical USDC, oracle, WETH, DEX manager/factory/router and their relationships; record deployment receipts, constructor args, bytecode verification and quote policy |
| Treasury | Existing test deployment uses a wallet address | Choose a reviewed treasury/multisig and ensure it can receive native fees and make one-time configuration/quote approvals; test intended role and emergency procedures before deployment |
| Upload abuse/storage | Public CSRF token is not wallet authorization; limit is process-local and shared | Add replay-safe upload authorization or equivalent paid-launch binding, durable quotas, storage limits and orphan cleanup; avoid introducing another creator signature into the launch flow without an explicit UX decision |
| Metadata availability | Public IPFS pinning absent | Establish pinning/hosting retention, quotas, provider failure behavior, integrity checks and monitoring; document what happens if hosting is lost |
| Operations | Volume and worker are active; restore/alert evidence absent | Exercise backup restoration and index replay, monitor index lag/oracle age/RPC/storage/fee failures, handle restart and outage, and retain sanitized request IDs |
| Release identity | Current tests target Sepolia | Produce a frozen release manifest, verify build/source parity, obtain a deployer-controlled mainnet runbook and keep test faucets/impersonation/simulation funding unreachable on mainnet |

## Reviewer threat model

Assume malicious traders, launch creators, transaction ordering, untrusted token metadata, a compromised browser, stale or unavailable RPCs/oracles, and a hostile pre-existing DEX pool. Treat approved quote tokens, DEX deployments, oracle proxies, treasury/configuration keys, hosting/pinning providers and wallet execution semantics as explicit trust dependencies.

Check conservation of curve reserves and fee liabilities across buy/sell/withdraw; sale cap and terminal price continuity; migration failure rollback; NFT custody and allowance cleanup; fee collection that cannot extract principal; beneficiary failure isolation; launch reentrancy guards and refunds; immutable quote approval implications; and batch ID/chain/receipt verification without duplicate launches. Review the oracle freshness dependency even when the user elects to pay the fixed USDC fee.

An existing active pool at a mismatched price can block migration. The code deliberately reverts rather than depositing at the wrong price; this remains a liveness/griefing concern requiring review. A permanently locked position has no recovery escape hatch. Fees earned by third-party liquidity positions are not Elpida fees.

Market cap currently uses price times total 1B supply as the product's display convention. Indexer circulating supply excludes curve/pool inventory and known dead-address balances. Review and document this distinction before marketing valuation figures.

## Capability limits

Base is the first proposed beta scope. Advanced holder distributions, buybacks, X/website verification and tokenized-stock rewards are simulation-only. Solana and other EVM chains need their own contracts, verified adapters, oracle choices and lifecycle tests. Cross-chain unified balances, sponsored gas and universal one-confirmation launches are not implemented. Do not market these as mainnet capabilities.

## Reproduction and handoff

On 13 October 2026, the focused security suite passed **25 tests, zero failures and zero skips**:

`node --test --test-concurrency=1 tests/usd-pricing.test.mjs tests/beta-curve.test.mjs tests/dex-migration.test.mjs tests/post-migration-fees.test.mjs tests/api.test.mjs tests/price-keeper.test.mjs tests/wallet-batch.test.mjs`

`npm audit --json` and `npm audit --omit=dev --json` both reported zero known vulnerabilities. This only checks known dependency advisories; it does not audit contract logic. Some server runtime packages are currently listed as devDependencies, so the full scan matters and a production install that omits devDependencies is not yet a supported runtime image.

Use npm run test:base-fork for deployed Sepolia integration, npm run testnet:check for read-only public status, and the focused security suite recorded in the review handoff. Fork balances and hashes are local evidence only. Never pass a private key to testnet:check.

The audit package generator exports allowlisted source, tests, lockfile and documentation plus SHA-256 hashes. It excludes .env, Circle recovery files, caches, local data, wallet keys, backups and synced ChatGPT sources. Send the resulting package to an auditor only through a destination authorized by the project owner.
