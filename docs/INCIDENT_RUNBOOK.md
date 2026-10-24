# Incident runbook (mainnet checklist C5 and D7, 22 October 2026)

What to do when something breaks, in the order to try it. Written during a Railway outage. Owner: Malik.
Testnet today; the same steps apply at mainnet, where speed matters more.

**What is never at risk.** Tokens, curves, pools, locked liquidity and fees live on-chain. If the site is down, no
funds are lost or frozen: the contracts keep working, and graduated tokens trade on Uniswap, PancakeSwap or
PumpSwap directly. What the site holds is convenience data: the trade index (rebuildable from the chain), token
details hosted by Elpida (not rebuildable unless pinned to IPFS or backed up), and operational state.

## 1. Detect

| Signal | Where | Meaning |
|---|---|---|
| Fallback page on elpida.fun | Browser | Cloudflare's `elpida-fallback` worker is answering because Railway does not |
| `GET https://elpida.fun/health` not 200 | Uptime monitor | Service down or restarting |
| `GET /api/operations/status` returns 503 | Uptime monitor | Critical incident (indexer stalled, backup failed or overdue, storage full) |
| `operations_incident` lines | Railway logs | Each incident starting or resolving, logged once |

**Set up alerts (free, about 10 minutes, Malik).** In UptimeRobot (free plan) add two HTTP(s) monitors: one on
`https://elpida.fun/health` with keyword `"status":"ok"`, and one on `https://elpida.fun/api/operations/status`
that alerts on any non-200 response. Use the email alert. Railway's own deploy-failure email stays on as well.
This closes D7's "alerts reach a person" once the first test alert arrives.

## 2. Triage: which incident is it?

1. Open https://status.railway.com. If Railway reports an incident, this is **A. Host outage**.
2. Otherwise open Railway → elpida → Deployments. A failed or crashing latest deploy is **B. Bad deploy**.
3. If the site loads but data is stale or missing, check `/api/operations/status`:
   - `indexer_*` means **C. RPC outage**.
   - `price_*` means **D. Stale prices**.
   - `graduation_*` means **E. Keeper**.
   - `backup_*` means **F. Backups**.
4. Anything involving a key, a leaked value or an unexpected on-chain action is **G. Security**. Go there first.

## A. Host outage (Railway down)

1. **Wait if it is short.** The fallback page keeps the domain answering, and nothing on-chain is affected. Post a
   short note on X: the site is down, funds are on-chain and safe, and graduated tokens trade on the DEX.
2. **If it lasts more than a few hours, run the site from another machine.** The cheapest way is Malik's PC plus a
   free Cloudflare Tunnel:
   1. On the PC: `git pull`, `npm.cmd ci`, then restore data (step 3) into a new folder and set
      `ELPIDA_DATA_DIR` to it. Without a restore the indexer rebuilds trades from the chain; only Elpida-hosted
      token details would be missing.
   2. Start the site: `$env:ELPIDA_PUBLIC_URL="https://elpida.fun"; npm.cmd start`. It listens on port 3000
      unless `PORT` is set.
   3. Install `cloudflared`, run `cloudflared tunnel login`, then create a tunnel to `http://localhost:3000` and
      route `elpida.fun` to it. This replaces the proxied CNAME to Railway until you switch back.
   4. Keep the PC awake. When Railway recovers, point the DNS record back to Railway and stop the tunnel.
3. **Restore the data.** Railway's bucket may be down with Railway, which is why the mirror exists (section F):
   ```
   $env:ELPIDA_BACKUP_MIRROR_S3_ENDPOINT="…"; $env:ELPIDA_BACKUP_MIRROR_S3_BUCKET="…"
   $env:ELPIDA_BACKUP_MIRROR_S3_ACCESS_KEY_ID="…"; $env:ELPIDA_BACKUP_MIRROR_S3_SECRET_ACCESS_KEY="…"
   $env:ELPIDA_BACKUP_ENCRYPTION_KEY="…"   # from your offline copy, never from chat
   npm.cmd run backup:offsite -- review --from-mirror        # lists snapshots; pick the newest
   npm.cmd run backup:offsite -- restore ops-… C:\elpida-restore --from-mirror
   ```
   The restore checks every object's identity, authentication tag and hash, and refuses an existing folder.

## B. Bad deploy

Railway → Deployments → the last good deployment → **Redeploy**. That restores the previous build in about two
minutes, and data on the volume is untouched. Then revert or fix the PR on GitHub; never push to `main` directly.
`/health` reports the running commit (`build`), so you can confirm which code is live.

## C. RPC outage (indexer behind)

Trades still settle on-chain, but the site shows stale data. Set `ELPIDA_RPC_<chainId>` (for example
`ELPIDA_RPC_84532` for Base Sepolia) to another provider's URL in Railway variables, and redeploy. The indexer
resumes from its last block. Remove the override when the default RPC recovers. Solana uses `SOLANA_RPC_URL`.

## D. Stale prices

Display prices are cosmetic. Launch pricing reads the on-chain oracle and refuses a stale one by design, so new
launches pause until the feed updates. No action unless it lasts more than an hour; then check the feed on the
explorer.

## E. Graduation keeper

`graduation_disabled` or `graduation_delayed` with `needs_gas` means the operator gas wallet needs funds. Fund it.
Model 10 curves graduate in the final buy anyway; the keeper only serves older curves. Anyone can still graduate
manually from the token page, and after 24 hours anyone can reopen a stuck curve.

## F. Backups

- `backup_failed` or `backup_overdue` (critical): check the Railway logs for `backup_failed` and its code (for
  example `AccessDenied` or `NoSuchBucket`). Fix the bucket variables, then check that `backup_verified`
  appears again.
- **Mirror (second provider).** Railway's bucket protects against losing the volume, not against Railway going down.
  Add a second S3-compatible bucket at another provider. The code copies each verified snapshot there too, reads every
  object back, and retries hourly if it fails. A mirror problem is only a warning (`backup_mirror_failed` or
  `backup_mirror_behind`) and never stops the main backup.
  - **Backblaze B2:** 10 GB free. Create a private bucket and an application key limited to it.
  - **Cloudflare R2:** 10 GB free, but it needs a payment method on file.
  - **Tigris** (`console.storage.dev`): 5 GB free, no card. Endpoint `https://t3.storage.dev`, region `auto`. Railway's
    own buckets run on Tigris, so this survives a Railway outage or account problem but not a Tigris outage. In use
    from 24 Oct 2026 (bucket `elpida-backup-mirror-malik`) because Backblaze lets a new account create API keys only
    after its first billing cycle (it needs a verified phone number first).

  Within a minute of each start, the server writes a small random object (`elpida-mirror-check.bin`, outside the
  snapshot prefix) and reads it back: `backup_mirror_reachable` means the endpoint, bucket and key work, and
  `backup_mirror_unreachable` gives the error code (for example `InvalidAccessKeyId`, `AccessDenied`). The local copy
  of the latest snapshot does not survive a redeploy, so after one the status shows `waitingForNextBackup` and the
  next daily backup goes to both buckets.

  Set the following Railway variables, then confirm `backup_mirror_verified` in the logs after the next backup:

  | Variable | Value |
  |---|---|
  | `ELPIDA_BACKUP_MIRROR_S3_ENDPOINT` | e.g. `https://s3.<region>.backblazeb2.com` or `https://<account>.r2.cloudflarestorage.com` |
  | `ELPIDA_BACKUP_MIRROR_S3_BUCKET` | the bucket name |
  | `ELPIDA_BACKUP_MIRROR_S3_REGION` | B2: the region in the endpoint; R2: `auto` |
  | `ELPIDA_BACKUP_MIRROR_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | the key pair |

  The mirror uses the same encryption key, so it holds only ciphertext. Keep the key's offline copy current.
- Storage grows with every daily snapshot because nothing is deleted automatically. The Railway bucket held about
  839 MB on 21 Oct. Run `npm run backup:offsite -- review` (and `-- review --from-mirror`) monthly and delete
  snapshots older than the proposal by hand, so the mirror stays inside its free 10 GB.

## G. Security

1. A key or secret may be exposed: rotate it at the provider first, then remove it everywhere it was set. Run
   `npm run security:scan -- --history` to check the repo.
2. An unexpected contract action: record the transaction hash. Contracts have no upgrade path, so the response is
   to stop promoting the affected launchpad and warn users. Mainnet needs C3 (multisig) before launch for this
   reason.
3. Write down what happened, when, and what was done, in `docs/` as an incident note.

## Restore drill (C5, timed)

Run once before mainnet, then quarterly. Use a staging service or the PC, never production's volume.

| Step | Target | Measured |
|---|---|---|
| Find the newest snapshot (`review`) | 2 min | |
| Restore it (`restore … [--from-mirror]`) | 10 min | |
| Start the app on the restored folder; `/health` 200 | 5 min | |
| Token and trade counts match production; token details resolve; indexer resumes | 10 min | |
| **Total (recovery time)** | **under 30 min** | |

Data loss on a restore is at most one backup interval (24 hours of hosted token details). Trades are rebuilt from
the chain. The first drill (13 Oct, Railway staging) passed untimed; record the timed run here.
