#!/usr/bin/env bash
# One-time setup of an Oracle Cloud VM for Elpida (Ubuntu 24.04, Ampere A1). docs/ORACLE_HOSTING.md, step 3.
#
#   sudo apt-get update && sudo apt-get install -y git
#   git clone https://github.com/ulquimakesmagic/ELPIDA.git ~/elpida-setup
#   sudo bash ~/elpida-setup/deploy/oracle/setup.sh
#
# Safe to run again. It never prints a secret: the Cloudflare Tunnel token is read with a hidden prompt and the
# variables file is filled by Malik in an editor on the server.
set -euo pipefail
REPO="${ELPIDA_REPO:-https://github.com/ulquimakesmagic/ELPIDA.git}"
APP=/opt/elpida/app DATA=/var/lib/elpida WORK=/var/lib/elpida-work ETC=/etc/elpida

[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "Warning: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}."
export DEBIAN_FRONTEND=noninteractive

echo "== 1/8 System updates"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -q ca-certificates curl gnupg git build-essential python3 unattended-upgrades jq

echo "== 2/8 Automatic security updates (reboots at 04:30 UTC only when a kernel update needs it)"
cat > /etc/apt/apt.conf.d/52elpida-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

echo "== 3/8 Node.js 24 (NodeSource, signed) and cloudflared (Cloudflare, signed)"
install -d -m 0755 /etc/apt/keyrings /usr/share/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt-get update -q
apt-get install -y -q nodejs cloudflared
node --version

echo "== 4/8 Swap (4 GB, only used if memory runs out)"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 4G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 5/8 The elpida user and its folders"
id elpida >/dev/null 2>&1 || useradd --system --home-dir /opt/elpida --shell /usr/sbin/nologin elpida
install -d -o elpida -g elpida -m 0750 /opt/elpida "$DATA" "$WORK"
install -d -o root -g elpida -m 0750 "$ETC"
if [ ! -f "$ETC/elpida.env" ]; then
  install -o root -g elpida -m 0640 /dev/null "$ETC/elpida.env"
  echo "# Paste the ELPIDA service's variables from Railway (Variables -> Raw Editor) below this line." > "$ETC/elpida.env"
fi
[ -f "$ETC/staging.env" ] || { echo "ELPIDA_PUBLIC_URL=https://staging.elpida.fun" > "$ETC/staging.env"; chown root:elpida "$ETC/staging.env"; chmod 0640 "$ETC/staging.env"; }

echo "== 6/8 The code"
if [ ! -d "$APP/.git" ]; then sudo -u elpida git clone --quiet "$REPO" "$APP"; fi
sudo -u elpida git -C "$APP" fetch --quiet origin
sudo -u elpida git -C "$APP" checkout --quiet --detach origin/main
(cd "$APP" && sudo -H -u elpida npm ci --omit=dev --no-audit --no-fund)
echo "ELPIDA_BUILD=$(sudo -u elpida git -C "$APP" rev-parse HEAD)" > "$ETC/build.env"
chmod 0644 "$ETC/build.env"

echo "== 7/8 The service (installed, not started until the variables are in) and automatic deploys"
for f in elpida.service elpida-update.service elpida-update.timer; do install -m 0644 "$APP/deploy/oracle/$f" "/etc/systemd/system/$f"; done
systemctl daemon-reload
systemctl enable elpida >/dev/null
# New commits on main deploy themselves within about 5 minutes (update.sh --auto), as on Railway.
systemctl enable --now elpida-update.timer >/dev/null

echo "== 8/8 Cloudflare Tunnel"
if systemctl is-enabled cloudflared >/dev/null 2>&1; then
  echo "cloudflared is already installed as a service."
else
  echo "Paste the tunnel token from Cloudflare (Zero Trust -> Networks -> Tunnels -> your tunnel -> install command,"
  echo "the long text after --token). It stays hidden. Press Enter on an empty line to skip for now."
  read -rs TOKEN; echo
  if [ -n "$TOKEN" ]; then cloudflared service install "$TOKEN" >/dev/null && echo "cloudflared installed."; else echo "Skipped. Run: sudo cloudflared service install <token>"; fi
  unset TOKEN
fi

cat <<'NEXT'

Setup done. Next (docs/ORACLE_HOSTING.md, step 4):
  1. sudo nano /etc/elpida/elpida.env     paste Railway's variables, save (Ctrl+O, Enter, Ctrl+X)
  2. sudo bash /opt/elpida/app/deploy/oracle/restore.sh list
  3. sudo bash /opt/elpida/app/deploy/oracle/restore.sh <snapshot id>
  4. sudo bash /opt/elpida/app/deploy/oracle/doctor.sh      and send Claude its output (it shows names, never values)
The server starts in staging mode (keepers and backups off) while /etc/elpida/staging.env exists.
NEXT
