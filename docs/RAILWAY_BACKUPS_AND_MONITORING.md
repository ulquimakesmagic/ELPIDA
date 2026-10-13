# Railway backup activation and monitoring

The application contains daily encrypted backup automation, upload readback verification, off-site restoration tooling and operational health checks. **Production off-site backups are active, and the first actual Railway bucket snapshot and separate staging restore were verified on 13 October 2026.** These operational checks do not replace an independent security audit.

## Verified Railway recovery drill

- Private bucket: `elpida-backups` in the existing Railway project. Production uses bucket-variable references and a separately retained encryption key, with a 24-hour schedule.
- First snapshot: `ops-1791928111473-54c1c42d-a177-4460-8c16-e20a7e02e9f8`. Production reported lastSuccess `2026-10-13T21:48:34.288Z`; its Railway log showed `backup_verified`, 10 objects (nine data files and the encrypted manifest). Bucket usage was about 15.8 MB. Operations status was `ok` with no incidents.
- A new empty `restore-staging` environment and `elpida-restore` service were created with a separate volume mounted at `/recovery-volume`. Circle credentials were not copied, no public domain was generated, and automatic backups stayed disabled.
- The actual snapshot was downloaded, authenticated, decrypted and hash-verified directly into the fresh `/recovery-volume/restored-data` destination. Both SQLite databases passed `PRAGMA integrity_check`: Base contained three tokens and ten trades; Solana contained zero tokens/trades. ELTEST's content-addressed metadata was present.
- The fresh volume initially belonged to root and the application could not write there. Its ownership and the recovered folder's ownership were corrected to the existing `node` user; the app's privilege level was not increased.
- After switching `ELPIDA_DATA_DIR` to the restored folder and removing all six temporary bucket/key variables, staging restarted successfully. Internal HTTP checks returned health 200, the three symbols ELTEST/JUICEWRLD/JOSH, and metadata name `Elpida Lifecycle Test`. Base indexing resumed with lag 2 and no error. Runtime checks confirmed the temporary encryption key, bucket secret and Circle API key were absent.
- Final staging deployment: `00dd925c-55ce-44dd-ba32-d011abffcf26`. Production's volume was never overwritten. Staging remains a private running service with a separate volume; it has provider usage costs until stopped or removed. This drill verifies recovery from the selected snapshot, not a regional outage or restoration of excluded private credentials.

## Activate the private bucket

1. In the existing Railway project, add a private storage bucket for Elpida backups. Open its Credentials tab. Railway supports S3-compatible access; use the listed endpoint, region and URL style. Do not paste credentials into chat or commit them.
2. Add service-variable references from that bucket to the Elpida service:

| Elpida variable | Railway bucket field |
| --- | --- |
| ELPIDA_BACKUP_S3_ENDPOINT | ENDPOINT |
| ELPIDA_BACKUP_S3_BUCKET | BUCKET |
| ELPIDA_BACKUP_S3_REGION | REGION |
| ELPIDA_BACKUP_S3_ACCESS_KEY_ID | ACCESS_KEY_ID |
| ELPIDA_BACKUP_S3_SECRET_ACCESS_KEY | SECRET_ACCESS_KEY |

Railway's current bucket URLs normally use virtual-hosted addressing. Leave ELPIDA_BACKUP_S3_PATH_STYLE=false unless its Credentials tab says to use path-style addressing. See [Railway bucket documentation](https://docs.railway.com/storage-buckets).

3. A fresh 32-byte key has been generated locally in `.env.backup-key`, which is ignored by Git. Copy its ELPIDA_BACKUP_ENCRYPTION_KEY value into a sealed Railway service variable. Store a separate secure copy outside Railway and the mounted volume. Losing this key makes encrypted backups unreadable. Preserve older keys when deliberately rotating; automatic key rotation is not implemented.
4. Set ELPIDA_BACKUP_ENABLED=true and ELPIDA_BACKUP_INTERVAL_HOURS=24. Keep a single app replica using the data volume. Work files default to a container-local temporary directory outside the live data directory. The scheduler starts thirty seconds after startup, runs without overlapping itself, and preserves attempt/success state on the data volume. Failed attempts retry no more than hourly.
5. Verify `backup_verified` in Railway logs and `/api/operations/status` reports backup.enabled=true with a recent lastSuccess. Every object is AES-256-GCM encrypted with its remote identity authenticated, uploaded, downloaded and SHA-256 checked. The encrypted manifest is published last. Uploading only some objects does not count as a completed backup.

The AWS S3 client runs server-side. Bucket credentials and the encryption key never appear in the browser configuration or public status. No user wallet key is read, and no extra launch signature is added.

## Scope, retention and limits

Backups include metadata (including provisional drafts), retention state and recognized public index databases. SQLite backup includes committed WAL data. Circle wallet/entity-secret material, private simulation journals and upload-admission state are excluded and require separately reviewed recovery procedures.

The backup format supports up to 50,000 files, a 16 MB manifest and 2 GB per encrypted object. Larger snapshots fail visibly rather than being reported as recoverable. Streaming encryption limits memory use. Local work folders are registered persistently; older registered work copies are removed only after a newer remote copy has been verified, with paths checked against the selected work directory. Unknown folders and symlinks are never deleted. Three unfinished working folders stop further attempts for operator review, preventing uncontrolled local growth.

No bucket objects are automatically deleted. Railway does not currently support bucket lifecycle rules. `npm run backup:offsite -- review` produces a read-only 30-day/seven-snapshot retention proposal for operator review; see OPERATIONS_ALERTS_AND_RETENTION.md. Partial remote uploads can remain without a committed manifest and are never age-based deletion candidates. Bucket upload/download and retained objects incur provider usage; review budgets and access controls.

## Restore drill in a separate Railway staging service

Use a temporary staging service with a fresh volume. Provide bucket-read credentials and the retained encryption key; omit Circle funding credentials and set ELPIDA_BACKUP_ENABLED=false and ELPIDA_SOLANA_CLUSTER=devnet. Use its staging HTTPS origin, not the production ELPIDA_PUBLIC_URL. Verify pages and API data without connecting or signing with wallets. Retrieve the snapshot ID from the private `ops-backup-state.json` or the bucket's `elpida-backups/ops-.../MANIFEST.json.enc` object.

`npm run backup:offsite -- restore SNAPSHOT_ID NEW_DATA_DIR`

All object identities, authentication tags, manifest hashes and paths are checked. Existing restore destinations are refused. The command preserves its temporary work directory for inspection and reports its location. Set ELPIDA_DATA_DIR to the restored folder on the staging service, start the app and verify metadata, token/trade counts, SQLite integrity and index replay. Never overwrite the production volume for a drill. Do not mark the drill complete until the staging checks pass.

For an explicit one-off backup after configuration: `npm run backup:offsite -- run DATA_DIR`. Treat local mirror backups separately from production snapshots.

## Operational monitoring

`/api/operations/status` reports status, sanitized incidents, backup dates and metadata usage. It returns HTTP 503 for critical conditions and 200 for healthy/degraded states. It contains no credentials, bucket URLs or filesystem paths. Railway's existing `/health` remains the liveness check: do not replace it with the operational endpoint, since an RPC outage must not create restart storms.

Checks run each minute, with a three-minute warmup for price/indexer synchronization. Incident transitions are logged once as `operations_incident` active/resolved events. Monitor these in Railway logs; an external uptime/log alert service still needs configuration. No email, Slack or other third-party messaging was enabled.

Conditions include 80% metadata/provisional capacity (warning), full capacity (critical), old pending uploads (review), enabled indexers more than 100 blocks behind or three minutes without sync (critical), stale/missing display prices (warning), failed configuration/backups (critical), and backups more than two scheduled intervals overdue (critical). A recent first backup in progress is reported as initializing. Display-price monitoring does not replace contract oracle freshness checks or independent contract review.

## Verification

Local checks cover encrypted upload/restore, wrong-object and tampered ciphertext rejection, overwrite protection, scheduler restart deduplication, failed-upload reporting, S3 byte readback and download bounds, SQLite/WAL restoration, storage thresholds and incident transition suppression. The API regression confirms backups are reported inactive without credentials. The dependency installation reported zero known vulnerabilities; this is not an independent security audit.

Remaining external steps: configure off-site retention and external alert delivery, confirm separate recovery for private credentials and the encryption key, and arrange the independent contract audit. The actual bucket activation, first verified backup and separate Railway staging restore are complete.
