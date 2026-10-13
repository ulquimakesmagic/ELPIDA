# Alerts and backup retention

## State on 14 October 2026

Production encrypted backups and the separate staging restore are verified. A Railway observability dashboard has been created with disk, memory, CPU, egress, error logs and usage widgets. Disk is scoped to the production volume. The current account UI exposes Edit/Delete, but no Add monitor action for either disk or memory widgets. **A dashboard is not active alert delivery.** Resource threshold alerts have not been activated. Existing deployment/billing notifications are separate.

Better Stack's two external monitors are active and both visibly reported **Up** after creation on 14 October 2026. `Elpida availability` is monitor 5065878; `Elpida operations and backups` is monitor 5065887. The owner completed account access. Both use email alerts, with calls/SMS off, TLS verification on and no purchased upgrade. The exact configuration is in `config/uptime-monitors.json`. The free account's on-call page states that incidents notify team members; it does not provide a configurable primary-responder schedule. No colleagues or integrations were added.

- `/health` detects an unavailable application without making external RPC/backup failures a restart trigger.
- `/api/operations/status` returns 503 for critical conditions, including backup failure/overdue and indexer failure. Warning-only degraded states return 200; the status monitor does not notify for those warnings. The endpoint reveals no credentials or private paths.
- Active checks: every 180 seconds, 15-second timeout, 60-second failure confirmation and recovery. Better Stack's operations monitor test facility confirmed "We sent you a test alert" and that colleagues were not notified. Provider submission is verified; inbox receipt has not been independently confirmed. Production was not deliberately interrupted or corrupted for testing.
- Neither existing Railway logs nor a monitor driven solely by the application can prove the entire Railway region is reachable. The separate outside check covers reachability, including DNS and TLS, but does not replace security review.

## Retention review

Railway currently does not support bucket lifecycle rules, object versioning or object locks: https://docs.railway.com/storage-buckets. No automated remote deletion is enabled in Elpida.

Run `npm run backup:offsite -- review` in the production console with its existing environment. This reads only objects under `elpida-backups/`, with bounded pagination. It proposes a 30-day retention window while preserving at least the newest seven snapshots that have a manifest completion marker. Incomplete sets, future-dated sets and foreign objects remain for review. A marker is not a fresh restore verification.

Review the reported snapshot IDs and recovery requirements before approving any future cleanup. The command has no delete operation. There will be no age-based candidates while fewer than eight committed snapshots exist. Keep the encryption key independently available and preserve older keys when rotating. This storage provider is outside the mounted application volume, but remains within Railway; a provider-independent copy is a separate resilience decision.

## Remaining release requirements

Confirm receipt of the provider's test email. Obtain a retention cleanup decision after inspecting candidates (the first real inventory had one protected snapshot and no candidates). Arrange independent contract review, address findings, complete funded public graduation and validate Base mainnet deployment/treasury configuration. No mainnet deployment is approved by these operational checks.
