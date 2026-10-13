# Alerts and backup retention

## State on 14 October 2026

Production encrypted backups and the separate staging restore are verified. A Railway observability dashboard has been created with disk, memory, CPU, egress, error logs and usage widgets. Disk is scoped to the production volume. The current account UI exposes Edit/Delete, but no Add monitor action for either disk or memory widgets. **A dashboard is not active alert delivery.** Resource threshold alerts have not been activated. Existing deployment/billing notifications are separate.

Better Stack is the selected external monitor provider. Its sign-in page is prepared; account login/creation and acceptance of its terms must be completed by the owner. No third-party monitor or alert subscription has been created yet. The exact proposed monitors are in `config/uptime-monitors.json`. After login, create the two HTTP-status monitors, use email to the account owner, leave calls/SMS off, verify TLS, and confirm the allowed check frequency before saving. Do not buy a plan or add recipients without the owner's instructions.

- `/health` detects an unavailable application without making external RPC/backup failures a restart trigger.
- `/api/operations/status` returns 503 for critical conditions, including backup failure/overdue and indexer failure. Warning-only degraded states return 200; this proposed status monitor does not notify for those warnings. The endpoint reveals no credentials or private paths.
- Proposed checks: every 180 seconds, 15-second timeout, 60-second failure confirmation and recovery. Test delivery through the provider's test facility; do not deliberately stop production or corrupt its backups. Monitor creation and notification delivery remain unverified until the provider visibly confirms them.
- Neither existing Railway logs nor a monitor driven solely by the application can prove the entire Railway region is reachable. The separate outside check covers reachability, including DNS and TLS, but does not replace security review.

## Retention review

Railway currently does not support bucket lifecycle rules, object versioning or object locks: https://docs.railway.com/storage-buckets. No automated remote deletion is enabled in Elpida.

Run `npm run backup:offsite -- review` in the production console with its existing environment. This reads only objects under `elpida-backups/`, with bounded pagination. It proposes a 30-day retention window while preserving at least the newest seven snapshots that have a manifest completion marker. Incomplete sets, future-dated sets and foreign objects remain for review. A marker is not a fresh restore verification.

Review the reported snapshot IDs and recovery requirements before approving any future cleanup. The command has no delete operation. There will be no age-based candidates while fewer than eight committed snapshots exist. Keep the encryption key independently available and preserve older keys when rotating. This storage provider is outside the mounted application volume, but remains within Railway; a provider-independent copy is a separate resilience decision.

## Remaining release requirements

Activate outside monitors after owner login and confirm an actual test notification. Obtain a retention cleanup decision after inspecting candidates. Arrange independent contract review, address findings, complete funded public graduation and validate Base mainnet deployment/treasury configuration. No mainnet deployment is approved by these operational checks.
