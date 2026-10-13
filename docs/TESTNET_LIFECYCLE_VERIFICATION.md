# Lifecycle verification — 13 October 2026

The focused lifecycle suite passed all 15 checks, with zero failures or skips:

`node --test --test-concurrency=1 tests/usdc-payments.test.mjs tests/metadata-store.test.mjs tests/dex-migration.test.mjs tests/post-migration-fees.test.mjs tests/public-indexer.test.mjs`

This verifies automatic metadata association and first-buy rollback; metadata resolution after a fresh storage reader; native and USDC curve trades; bounded approvals and atomic approval/launch rollback; actual local Uniswap v3 graduation, both-direction pool trades and permanently locked positions; fee collection without moving principal; and public index persistence. These are local contract tests, not completed public-chain transactions.

## Public deployment observation

Railway's persistent storage is enabled. The Base Sepolia worker indexes factory `0xe605787F7260F5Dae2768d2F9E93E7F18EE14f91`, model 9 with metadata version 1. On inspection at 19:33 Lagos time, its last sync was healthy, nine blocks behind the reported head (including its two-confirmation policy). JUICEWRLD and JOSH both have verified factory origin. JUICEWRLD has indexed buys and sells; neither token has graduated. Both were created before automatic metadata association and have empty on-chain metadata references.

The connected test wallet had approximately 0.00498 ETH and 4.76 USDC. At inspection, completing JUICEWRLD required 16,197.283346 USDC; completing JOSH required approximately 6.39291 ETH. Network gas is additional. These changing amounts must be re-read before a transaction. Do not change production curve economics solely to make this test cheap.

`npm.cmd run testnet:check -- PUBLIC_WALLET_ADDRESS` repeats the read-only deployment, funding, metadata and indexed-trade inspection. It neither loads keys nor sends transactions. Without an address it inspects just the deployment and tokens.

## Remaining public-chain steps

1. Create a fresh Base Sepolia token with a small native first buy and the native launch fee. The wallet owner confirms the transaction after reviewing gas and balance. Verify its factory metadata reference resolves on a fresh page without browser-local metadata.
2. Verify a new public buy, sell and fee claim, including transaction receipts and indexed activity. Previous JUICEWRLD buy/sell/claim success does not prove the fresh token's metadata path.
3. Fund an existing curve sufficiently with test assets, complete it, graduate, verify the locker owns the position, trade both ways and claim the earned fees. Local success does not replace this public verification.
4. Test approval plus launch with a wallet that advertises atomic support. The current Zerion connection did not advertise it. Ordinary ERC-20 approvals can remain separate.

Public IPFS pinning is still not configured: the deployment hosts content-addressed metadata on its persistent volume. Advanced holder/X/website rewards remain simulation-only. Mainnet readiness requires independent contract/security review and completed chain-specific public lifecycle verification.
