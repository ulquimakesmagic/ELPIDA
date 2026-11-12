> **Historical (11 November 2026).** This document predates ELPIDA V2 and describes the legacy product. The current
> release gate is `docs/AUDIT_TRIAGE_2026-11-11.md`.

# Current release gates — 13 October 2026

Elpida remains a testnet product. Mainnet deployment scripts are preparation tools, not security approval. Older model-specific documents describe historical behavior; verify current code and deployment records before relying on their fee or network settings.

## Indexing recovery implemented in this development pass

The Solana indexer no longer checkpoints a successful signature until transaction metadata is available. Missing transaction details raise `TRANSACTION_PENDING` and retry from the last committed signature. Each transaction's trades and checkpoint now share a SQLite transaction, preventing partial commits. Failed transactions never contribute trade events. Only logs emitted by the configured Elpida program are accepted, including calls through routers; matching event bytes from unrelated programs are ignored.

Five focused tests cover nested program provenance, RPC unavailability across a restart, checkpoint-write rollback and retry, failed transactions, and failure-phase reporting/recovery. Public status and Railway logs identify the failing stage without exposing raw RPC errors or credentials. These tests use deterministic RPC fixtures and a real SQLite database; they do not establish Solana program or PumpSwap security. Run `node --test tests/solana-indexer.test.mjs` or `npm run test:indexer`.

The fix prevents future skipped transactions. It does not reconstruct history already skipped by an older deployment. Rebuilding affected indexes requires preserving a backup, selecting a sufficient historical range, and comparing the rebuilt database with chain transactions before replacing the live database. No production database is deleted or reset by this change.

## Gates before a limited mainnet release

- Complete and record public testnet native-fee and USDC-fee launches, buy/sell, curve completion, DEX graduation, locked-position ownership and fee claims. Check transaction hashes and balances, not only UI success states.
- Verify persistence after a service restart, index catch-up, RPC outages and recovery. Complete Solana post-graduation market coverage before advertising it as indexed.
- Confirm each enabled chain's deployed DEX addresses, quote assets, pricing feeds and finality settings. A working integration on one chain does not validate the others.
- Run adversarial and economic invariant tests and obtain independent review of the contracts, oracle validation, graduation adapter and fee locker. Document unresolved findings and mitigations.
- Secure treasury and upgrade privileges, verify production configuration excludes test faucets, and exercise backup restoration and incident procedures.
- Keep advanced holder rewards, buybacks, tokenized-stock rewards and identity claims explicitly unavailable until their public contracts/services are implemented and reviewed.

Begin with one validated chain and creator-wallet rewards. No mainnet deployment or real-fund transaction is authorized by this document.

## Railway RPC recovery — 13 October

The live Solana worker failed at `pool_snapshot`. Railway's `SOLANA_RPC_URL` contained four comma-separated Helius mainnet endpoints while the application used devnet. The value was corrected to a single Helius devnet endpoint with an existing credential. Following the configuration deployment, public status reported a successful sync, cursor slot 510311400, no error, and zero indexed launches/trades. Zero activity is not evidence of a completed launch test.

The server now rejects endpoint lists and invalid URLs without logging their contents. Before reading public pool state, the indexer checks the RPC genesis hash against the configured devnet/mainnet cluster and fails closed with `RPC_CLUSTER_MISMATCH`. Local validator networks are exempt from the fixed public-cluster hashes. Tests exercise malformed configuration, cluster mismatch, and recovery after correction.

The Base Sepolia test wallet still holds approximately 0.000499384 ETH. A funded public launch remains pending; no launch, trade, or wallet signature was submitted in this recovery pass.
