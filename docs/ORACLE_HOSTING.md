# Hosting Elpida on Oracle Cloud (Always Free)

Malik, 13 November 2026: Railway was costing about $8 a day, mostly memory (the ELPIDA service averages about 2.5 GB,
billed per GB-minute). This moves the server to an Oracle Cloud VM that costs nothing within Oracle's Always Free
limits, keeps Cloudflare in front (elpida.fun's DNS is already on Cloudflare, `DEPLOY_RESILIENCE.md`) and keeps the
encrypted off-site backups.

## What it looks like

```
visitor ──https──> Cloudflare (DNS, TLS, elpida-fallback Worker) ──Cloudflare Tunnel──> cloudflared on the VM
                                                                                          │
                                                                    Elpida on 127.0.0.1:3000 (systemd, user elpida)
                                                                    data: /var/lib/elpida (the VM's own disk)
                                                                    backups: S3 buckets, encrypted, daily
```

- **No open ports.** The tunnel is an outbound connection from the VM, so the server listens on 127.0.0.1 only and
  Oracle's firewall only needs SSH. Nobody can reach the server except through Cloudflare.
- **Visitors' addresses**: behind the tunnel every request arrives from 127.0.0.1, so rate limits read Cloudflare's
  `CF-Connecting-IP` (`ELPIDA_TRUST_PROXY=cloudflare`, set by `deploy/oracle/start.sh`). The header is only trusted
  when the request came from cloudflared on the same machine.
- **Durable storage**: `ELPIDA_DATA_DIR=/var/lib/elpida` counts as a persistent volume everywhere Railway's volume did
  (status pages, the production guard, metadata staging).
- **Deploys**: `elpida-update.timer` checks `main` every 5 minutes and deploys a new commit (`update.sh --auto`), as
  Railway did on every merge. If the new build does not answer `/health` with its own build id within 5 minutes it
  rolls back by itself and does not retry that commit. During the restart the Worker shows "Elpida is updating".
- **Files** (all in `deploy/oracle/`): `setup.sh` (once), `start.sh` (the service's start command), `update.sh`,
  `restore.sh`, `doctor.sh` (a report that shows variable names, never values), `elpida.service`, `elpida-update.*`.

## Oracle's free limits (checked 13 November 2026)

From Oracle's Always Free page (last changed 12 June 2026):

- **Ampere A1 (ARM)**: 1,500 OCPU hours and 9,000 GB hours a month, that is **2 OCPUs and 12 GB of memory** in total
  (it was 4 and 24 before). One VM with 2 OCPU / 12 GB uses all of it. Elpida needs about 2.5 GB, so the rest is room.
- **Disk**: 200 GB of boot and block volumes in the home region. A 100 GB boot volume leaves 100 GB spare.
- **Object Storage**: 20 GB on an Always-Free-only account (10 GB per tier on a paid account). Usable as the second
  backup bucket.
- **Idle VMs can be reclaimed.** Oracle may stop an Always Free VM when, over 7 days, CPU (95th percentile), network and,
  on A1, memory all stay under 20%. Elpida's memory sits near 20% of 12 GB, so it is close. Two protections:
  1. Upgrade the account to **Pay As You Go** (Billing → Upgrade). Always Free resources stay free; many users report it
     stops idle reclamation, though Oracle's page does not promise that. Add a budget alert at $1 so any charge is
     noticed. Malik enters the card details himself.
  2. Backups: a stopped or lost VM is rebuilt with `setup.sh` + `restore.sh` in about half an hour.
- The **home region** is chosen at sign-up and cannot be changed; free A1 VMs exist only there. Pick the region nearest
  to most users that has A1 capacity. "Out of capacity" when creating the VM is common: try another availability
  domain, try again later, or upgrade to Pay As You Go, which gets capacity more easily.

## Steps

### 1. Oracle account and VM (Malik; now)

1. Sign up at oracle.com/cloud/free. Choose the home region carefully (above). A card is checked but not charged.
2. On the Windows PC, make an SSH key (PowerShell):
   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\elpida-oracle
   Get-Content $HOME\.ssh\elpida-oracle.pub
   ```
   The `.pub` line is public and safe to paste into Oracle. The other file is the private key: it never leaves the PC.
3. Oracle console → Compute → Instances → **Create instance**:
   - Name `elpida-1`.
   - Image: **Canonical Ubuntu 24.04** (the regular one, not Minimal).
   - Shape: Ampere → **VM.Standard.A1.Flex**, **2 OCPUs, 12 GB**. It shows "Always Free-eligible".
   - Networking: create a new virtual cloud network with a public subnet; **assign a public IPv4 address** (for SSH).
   - SSH keys: **Paste public keys** → the `.pub` line.
   - Boot volume: specify a size → **100 GB**.
   - Create, wait for "Running", copy the public IP.
4. Connect: `ssh -i $HOME\.ssh\elpida-oracle ubuntu@<public IP>`.

Oracle's Ubuntu image already blocks every inbound port except SSH; nothing else needs opening.

### 2. Cloudflare Tunnel (Malik; can be done while the VM is being created)

Cloudflare dashboard → **Zero Trust** (choose the Free plan if asked) → Networks → **Tunnels** → Create a tunnel →
Cloudflared → name `elpida-oracle` → on the install page, copy the token (the long text after `--token`). Keep it to
paste on the VM in step 3; never into chat. Then add a **public hostname** (also called a published application route):

| Subdomain | Domain | Type | URL |
|---|---|---|---|
| `staging` | `elpida.fun` | HTTP | `127.0.0.1:3000` |

Use `127.0.0.1`, not `localhost` (the server does not listen on IPv6). elpida.fun itself stays on Railway until step 7.

### 3. Set up the VM (Malik, after the hosting PR is merged)

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ulquimakesmagic/ELPIDA.git ~/elpida-setup
sudo bash ~/elpida-setup/deploy/oracle/setup.sh
```

It installs updates, automatic security updates, Node 24, cloudflared, a 4 GB swap file, the `elpida` user, the code
in `/opt/elpida/app`, the services, and asks for the tunnel token (hidden). About 10 minutes. It can be run again.

### 4. Variables and a test restore (Malik)

1. Railway → ELPIDA service → Variables → **Raw Editor** → select all, copy.
2. On the VM: `sudo nano /etc/elpida/elpida.env` → paste below the first line → add `ELPIDA_PUBLIC_URL=https://elpida.fun`
   if it is not there → Ctrl+O, Enter, Ctrl+X. The paste goes from your PC to your server over SSH; it is not shown to
   anyone else.
3. `sudo bash /opt/elpida/app/deploy/oracle/doctor.sh` and send Claude the output: it lists names and problems,
   never values. Fix what it marks:
   - `FIX ... Railway reference ${{...}}`: Railway shows some variables as references to another service (the backup
     bucket's keys). Copy the real value from that variable's eye icon in Railway instead.
   - `REMOVE RAILWAY_...`: delete those lines.
   - `ELPIDA_GRADUATION_KEY_FILE`: a key file on Railway's volume does not come along (backups never contain keys).
     Either create it on the VM — `sudo nano /etc/elpida/graduation.key`, paste the Base Sepolia keeper key, then
     `sudo chown root:elpida /etc/elpida/graduation.key && sudo chmod 640 /etc/elpida/graduation.key` and set the
     variable to `/etc/elpida/graduation.key` — or delete the variable to leave automatic graduation off.
4. `sudo bash /opt/elpida/app/deploy/oracle/restore.sh list` → the newest snapshot id →
   `sudo bash /opt/elpida/app/deploy/oracle/restore.sh <id>`.

### 5. Check staging (Malik and Claude)

The VM runs in **staging mode** while `/etc/elpida/staging.env` exists: the keeper, relay and Circle keys are removed
before start and backups are off, so it never signs a transaction or writes a backup while Railway is still live. It
answers at https://staging.elpida.fun. Check Explore, a token page, Learn, the operator panel (read-only), `/health`.
Do not launch or trade on staging: Railway is still the real site. Chain indexes not in the backup rebuild from the
chain in the first minutes.

### 6. Backups after the move

Railway's bucket keeps working from the VM until Railway is shut down, so nothing changes on the day. Within the
following week:

- **Primary → Cloudflare R2** (free up to 10 GB; the current backups are about 6 GB). Replace the
  `ELPIDA_BACKUP_S3_*` lines with the R2 bucket's endpoint, bucket name, keys and `ELPIDA_BACKUP_S3_REGION=auto`.
- **Mirror → Oracle Object Storage** (free, a different provider from R2): create a bucket, then Profile → Customer
  secret keys → generate. `ELPIDA_BACKUP_MIRROR_S3_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`,
  `_REGION=<region id, e.g. eu-frankfurt-1>`, `_PATH_STYLE=true`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`.
- `sudo systemctl restart elpida`, then the operator panel's backup card should show both buckets healthy after the
  next daily run. Keep `ELPIDA_BACKUP_ENCRYPTION_KEY` unchanged: older snapshots need it.

### 7. Cut-over (Malik, with Claude watching; about 15 minutes, the Worker covers the gap)

1. Operator panel → backups: note the time of the last successful daily backup. Start soon after it; anything written
   between that backup and step 2 (holder chat, theses) is not carried over.
2. Railway → ELPIDA → the active deployment's menu → **Remove** (stops it; the volume and variables stay, so it can be
   redeployed). From here elpida.fun shows "Elpida is updating".
3. On the VM: `sudo bash /opt/elpida/app/deploy/oracle/restore.sh list`, restore the newest id, then
   `sudo rm /etc/elpida/staging.env && sudo systemctl restart elpida` (production mode: keepers and backups on).
4. Cloudflare → DNS: write down the `elpida.fun` CNAME target (the `*.up.railway.app` host, needed to roll back), then
   delete that record. Tunnel → public hostname → add: subdomain empty, domain `elpida.fun`, HTTP, `127.0.0.1:3000`.
   The `elpida-fallback` Worker route `elpida.fun/*` stays as it is.
5. Check https://elpida.fun/health shows the VM's build, and `doctor.sh` says PRODUCTION.

**Roll back**: delete the tunnel's `elpida.fun` hostname, recreate the CNAME to the Railway host (Proxied), Railway →
Redeploy, and on the VM put staging mode back:
`echo ELPIDA_PUBLIC_URL=https://staging.elpida.fun | sudo tee /etc/elpida/staging.env && sudo systemctl restart elpida`.

### 8. After a week without problems

Malik deletes the Railway ELPIDA service, its volume, the `elpida-restore` service and (once R2 is primary) the
`elpida-backups` bucket. That removes most of the Railway bill (this project was about $5.90 of the $8.43 used from 10 to 13 November).

## Day to day

| Task | Command (on the VM) |
|---|---|
| Health report to share | `sudo bash /opt/elpida/app/deploy/oracle/doctor.sh` |
| Logs | `sudo journalctl -u elpida -f` |
| Deploy now / go back to a commit | `sudo bash /opt/elpida/app/deploy/oracle/update.sh [commit]` |
| Turn automatic deploys off / on | `sudo systemctl disable --now elpida-update.timer` / `enable --now` |
| Change a variable | `sudo nano /etc/elpida/elpida.env` then `sudo systemctl restart elpida` |
| Restart | `sudo systemctl restart elpida` |

The VM installs security updates by itself and reboots at 04:30 UTC only when an update needs it; the services start
again on boot.
