# Upload admission, conservative cleanup and recovery

## Admission before large uploads

Metadata staging now requires a payload-bound, single-use challenge and a small automatic browser computation before reading the request body. A worker performs the computation so a large logo does not freeze the interface. A random HttpOnly, SameSite=Strict session cookie binds the challenge to that browser. This is anonymous admission, not wallet identity or financial authorization. The launch transaction still authorizes retained metadata; no extra wallet signature is added.

Challenges expire after two minutes; the browser stops work after ninety seconds without relying on its clock matching the server. Difficulty is three leading hexadecimal zeroes of a Keccak-256 digest. Challenges and rate counters persist in metadata-admission.sqlite. Replays, wrong sessions, changed payloads, missing proofs and URL-query bypasses are rejected. Hashes of the socket peer and session are stored, not their raw values. Proxy forwarding headers are not trusted. A challenge remains usable if ingress selects another proxy hop; its original connection group supplies the rate-limit bucket.

Fixed-window limits: 10 uploads per session/hour; 50 uploads per connection group/hour; 20 uploads server-wide/minute; 1,000 uploads/day. Challenge issuance is limited to 60 per connection group/minute and 2,000/day server-wide. Existing storage quotas and the legacy publishing block remain in effect. These are intentionally conservative beta limits. A shared Railway proxy can group multiple users; production needs a reviewed trusted-edge policy and traffic-appropriate limits. Computation raises admission cost but does not make bots impossible. Rejected requests consume admitted work budgets, and resetting a browser cookie does not reset the connection-group budget.

The disabled public metadata/publish route is rejected before reading its body and does not consume the protected staging budget. This prevents legacy-route flooding from exhausting the admission quota without solving challenges.

Only one application replica should serve a shared admission database and metadata directory. A deployment must preserve the mounted volume. Close the service gracefully before relocating its storage. Existing launch-page tabs should be refreshed after this deployment; saved small drafts survive refresh.

## Backup and restore commands

`node scripts/storage-operations.mjs backup DATA_DIR NEW_SNAPSHOT_DIR`

Copies only metadata blobs/retention and recognized public EVM/Solana index files. SQLite uses its online backup API so committed WAL data is included. The operation excludes Circle wallets, entity-secret recovery, .env, simulation journals, admission state and private keys. Provisional metadata drafts are included, so keep the snapshot private. Metadata blobs are immutable; if the retention ledger changes during the copy, the snapshot is rejected as incomplete and must be retried into a fresh destination.

`node scripts/storage-operations.mjs restore SNAPSHOT_DIR NEW_DATA_DIR`

Verifies every manifest hash and allowlisted path before creating the target. Existing destinations, duplicate entries, symlinks and altered files are rejected. It never overwrites a live data directory. Restore metadata and its ledger together. Configure a separate staging service with ELPIDA_DATA_DIR pointing to the new directory, then check token metadata and indexer replay before any planned production cutover.

Admission state is excluded from the public-data snapshot: after a full service restore, anonymous limits restart unless its database is restored separately under private operational procedures. Circle funding credentials and wallet state require their own encrypted backup and access controls. This utility is not a complete machine/volume backup, off-site retention service or scheduled backup.

## Conservative cleanup

`node scripts/storage-operations.mjs cleanup CONTENT_DIR`

Dry-run report. `--apply` removes only temporary raw-CID blob files older than one day whose bytes exactly match an existing committed file. The committed blob is preserved. Missing or different committed content, pending/retained blobs, logos, ledger state and public pins are never deleted. Uncertain uploads remain for review; an old pending transaction may later confirm. Production blob deletion requires a separate reviewed retention decision.

## Verified locally — 13 October 2026

The targeted suite passed 22 checks, covering durable proof/counter recovery, replay/expiry, cookie-reset rate resistance, query-bypass rejection, metadata/index retention, SQLite online backup with committed WAL state, overwrite/corruption refusal, and duplicate-only cleanup.

A real snapshot of the local mirror was restored into a separate folder. Nine file hashes matched, SQLite integrity_check returned ok, and all three indexed tokens were preserved. Cleanup dry-run found no eligible duplicate files. No live data was overwritten or user funds moved. This does not certify restoration of Railway's actual volume.

Before mainnet, run the same drill in Railway staging, establish encrypted/off-site backup retention and alerting, verify private credential recovery separately, and obtain independent security review. The review package is ready; no independent auditor has been selected or contacted by the agent.
