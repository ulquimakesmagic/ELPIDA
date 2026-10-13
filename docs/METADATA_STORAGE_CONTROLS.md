# Chain-bound metadata retention and storage controls

Public staging remains available before the launch signature. A confirmed factory launch transaction is the authorization for retained storage; no separate creator signature is added. The validated public indexer replays canonical factory metadata references and retains the document and its uploaded logo. A failed chain synchronization cannot authorize retention. The creator-signed recovery flow for older tokens remains available.

Each public-server upload starts provisionally, including public simulation uploads. The legacy metadata/publish route is disabled before reading its body on a public server so it cannot independently grant retention or exhaust protected staging budgets. Staging uses durable anonymous admission plus a process-local 20/minute limit. Caller-supplied addresses do not authorize permanent retention. See STORAGE_OPERATIONS.md for the admission limits and recovery procedure.

Stored blob files have a **512 MB** aggregate limit and provisional blobs have a **100 MB** limit by default. Configure ELPIDA_METADATA_MAX_BYTES and ELPIDA_METADATA_MAX_PENDING_BYTES with positive integer byte values. Capacity is recalculated from stored blob files on restart; retention state uses a persistent atomic-write ledger. Existing files predating the ledger remain protected and count toward total capacity. The ledger and temporary-write overhead are additional to the blob quota.

Uploads fail before the wallet launch when capacity cannot be admitted. Preflight checks reserve a conservative document allowance before calling a public pinning provider; synchronous file writes enforce the actual blob limits again. If the image uploads but the document fails, the image remains provisional and counted. This prevents repeated failures from escaping the quota, although already-issued provider requests can still consume provider quota. Identical content deduplicates its stored blob.

Old provisional blobs are reported as expired after seven days, but **are not deleted automatically**. An uncertain wallet transaction can be confirmed later; age alone does not prove abandonment. Restarts, retries and delayed indexing must not destroy its metadata. Operations must review expired provisional usage and increase capacity or implement a reviewed cleanup policy; do not delete pending blobs just because their timestamp is old.

MetadataPublishing.storage in /api/config exposes total, pending and expired-pending bytes plus the configured caps; no credentials are exposed. Warn on storage reaching 80% of either cap, any expired-pending growth, or repeated METADATA_QUOTA errors. Test backup/restore of both blob files and retention.json together before mainnet.

Hosted content writes use temporary files and atomic rename. The persistent read cache is bounded at 16 MB of encoded data and can reload older blobs from disk. Files are served only by validated content identifiers. Corrupt raw-CID blobs fail integrity checks rather than being silently replaced.

## Verification

Metadata-store and API checks passed for 5 MB uploads, restart persistence, remote integrity, pending-to-retained promotion including the logo, quota rejection before pinning, deduplication and legacy-route limits. The public-indexer regression separately verifies promotion on a successful validated sync and refusal after a sync failure. Tests use simulated chain state or stubbed provider responses; they do not constitute an independent security audit.

## Remaining limitations

This is **chain-authorized retention, not authenticated pre-launch upload admission**. An attacker can consume provisional capacity or the shared request limit without creating a token. Quotas fail closed but can deny new launches; distributed per-client admission, durable rate limits, provider account spending limits and deliberate cleanup still need review. Only one process should write a given metadata directory: the ledger is not a distributed lock or a multi-replica quota manager. Public pinning is still not configured on the current Railway deployment.
