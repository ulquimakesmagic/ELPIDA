#!/usr/bin/env bash
# One-time setup of Elpida on a server that already runs other people's apps (24 November 2026: Micheal's Oracle VM,
# Ubuntu 24.04 arm64, with Caddy, Postgres, Redis and about ten services). docs/ORACLE_HOSTING.md, "Shared server".
#
#   git clone https://github.com/ulquimakesmagic/ELPIDA.git ~/elpida-setup
#   sudo bash ~/elpida-setup/deploy/oracle/setup-shared.sh
#
# Unlike setup.sh it changes nothing the other apps depend on: no system upgrade, no automatic updates or reboots, no
# swap, no system-wide Node (Node 24 goes to /opt/elpida/node), and its own tunnel service (elpida-tunnel) instead of
# cloudflared's, so an existing Cloudflare tunnel is left alone. Elpida listens on 127.0.0.1:3000 only and is capped
# at 2 CPUs and 4 GB so it cannot starve the other apps. Safe to run again. It never prints a secret.
set -euo pipefail
REPO="${ELPIDA_REPO:-https://github.com/ulquimakesmagic/ELPIDA.git}"
APP=/opt/elpida/app NODE_DIR=/opt/elpida/node DATA=/var/lib/elpida WORK=/var/lib/elpida-work ETC=/etc/elpida

[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/8 Checks (nothing is changed yet)"
if ss -tlnH 'sport = :3000' | grep -q . && ! systemctl is-active --quiet elpida; then
  echo "Port 3000 is already used by another app on this server. Stop here and tell Claude."; exit 1
fi
case "$(uname -m)" in aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Unsupported CPU $(uname -m)."; exit 1 ;; esac
echo "port 3000 free, CPU $ARCH"

echo "== 2/8 Missing tools only (installed packages are not upgraded)"
apt-get update -q
apt-get install -y -q --no-upgrade ca-certificates curl git jq xz-utils gnupg

echo "== 3/8 Node.js 24 for Elpida only, in $NODE_DIR (the system's Node, if any, is untouched)"
install -d -m 0755 /opt/elpida
want="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$ARCH.tar.xz" '$2 ~ a"$" {print $1" "$2}')"
[ -n "$want" ] || { echo "Could not read Node's release list."; exit 1; }
file="${want#* }"
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "$(echo "$file" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/latest-v24.x/$file"
  (cd "$tmp" && echo "$want" | sed 's/ /  /' | sha256sum -c --quiet) || { echo "Node download failed its checksum."; exit 1; }
  rm -rf "$NODE_DIR.new" && install -d "$NODE_DIR.new" && tar -xJf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR" && rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
node --version

echo "== 4/8 cloudflared (package only; an existing tunnel service is left as it is)"
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y -q --no-upgrade cloudflared
fi
cloudflared --version | head -1

echo "== 5/8 The elpida user and its folders"
id elpida >/dev/null 2>&1 || useradd --system --home-dir /opt/elpida --shell /usr/sbin/nologin elpida
chown elpida:elpida /opt/elpida
install -d -o elpida -g elpida -m 0750 "$DATA" "$WORK"
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
(cd "$APP" && sudo -H -u elpida env PATH="$PATH" npm ci --omit=dev --no-audit --no-fund)
echo "ELPIDA_BUILD=$(sudo -u elpida git -C "$APP" rev-parse HEAD)" > "$ETC/build.env"
chmod 0644 "$ETC/build.env"

echo "== 7/8 The services, a limit so Elpida stays a good neighbour, and automatic deploys"
for f in elpida.service elpida-update.service elpida-update.timer elpida-tunnel.service; do install -m 0644 "$APP/deploy/oracle/$f" "/etc/systemd/system/$f"; done
install -d /etc/systemd/system/elpida.service.d
cat > /etc/systemd/system/elpida.service.d/shared.conf <<'CONF'
# Written by setup-shared.sh: this server also runs other apps.
[Service]
CPUQuota=200%
MemoryHigh=3G
MemoryMax=4G
CONF
systemctl daemon-reload
systemctl enable elpida >/dev/null
systemctl enable --now elpida-update.timer >/dev/null

echo "== 8/8 Cloudflare Tunnel (Elpida's own, as elpida-tunnel)"
if [ -s "$ETC/tunnel.env" ]; then
  echo "The tunnel token is already saved."
else
  echo "Paste the tunnel token from Cloudflare (Zero Trust -> Networks -> Tunnels -> elpida-oracle -> install command,"
  echo "the long text after --token). It stays hidden. Press Enter on an empty line to skip for now."
  read -rs TOKEN; echo
  if [ -n "$TOKEN" ]; then
    install -o root -g root -m 0600 /dev/null "$ETC/tunnel.env"
    printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$ETC/tunnel.env"
    echo "Saved."
  else
    echo "Skipped. Run this script again to add it."
  fi
  unset TOKEN
fi
[ -s "$ETC/tunnel.env" ] && systemctl enable --now elpida-tunnel >/dev/null && echo "elpida-tunnel: $(systemctl is-active elpida-tunnel)"

cat <<'NEXT'

Setup done. Nothing outside /opt/elpida, /var/lib/elpida*, /etc/elpida and the elpida* services was changed.
Next (docs/ORACLE_HOSTING.md, step 4):
  1. sudo nano /etc/elpida/elpida.env     paste Railway's variables, save (Ctrl+O, Enter, Ctrl+X)
  2. sudo bash /opt/elpida/app/deploy/oracle/restore.sh list
  3. sudo bash /opt/elpida/app/deploy/oracle/restore.sh <snapshot id>
  4. sudo bash /opt/elpida/app/deploy/oracle/doctor.sh      and send Claude its output (it shows names, never values)
The server starts in staging mode (keepers and backups off) while /etc/elpida/staging.env exists.
NEXT
