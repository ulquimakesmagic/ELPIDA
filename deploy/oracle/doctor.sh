#!/usr/bin/env bash
# A health report for the Oracle VM that is safe to paste into chat: variable NAMES only, never their values.
#   sudo bash /opt/elpida/app/deploy/oracle/doctor.sh
set -uo pipefail
ENVF="${ELPIDA_ENV_FILE:-/etc/elpida/elpida.env}"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
say() { printf '%-22s %s\n' "$1" "$2"; }

say "host" "$(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m), $(nproc) CPU, $(free -g | awk '/^Mem/{print $2" GB RAM, "$7" GB free"}')"
say "disk" "$(df -h /var/lib | awk 'NR==2{print $4" free of "$2}'), data $(du -sh /var/lib/elpida 2>/dev/null | cut -f1)"
say "node" "$(node --version 2>/dev/null || echo missing)"
say "code" "$(sudo -u elpida git -C /opt/elpida/app log -1 --format='%h %cs %s' 2>/dev/null | cut -c1-80)"
say "mode" "$([ -f /etc/elpida/staging.env ] && echo 'STAGING (keepers and backups off)' || echo 'PRODUCTION')"
say "elpida service" "$(systemctl is-active elpida) since $(systemctl show elpida -p ActiveEnterTimestamp --value)"
say "cloudflared" "$(systemctl is-active cloudflared 2>/dev/null)"
say "health" "$(curl -fsS --max-time 5 http://127.0.0.1:3000/health 2>/dev/null || echo 'no answer on 127.0.0.1:3000')"
status="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/public/status 2>/dev/null)"
[ -n "$status" ] && say "storage" "$(printf '%s' "$status" | jq -c '.storage | {durable}' 2>/dev/null)"

echo
if [ -f "$ENVF" ]; then
  names="$(grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$ENVF" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=.*//' | sort)"
  echo "Variables in $ENVF ($(printf '%s\n' "$names" | grep -c . ) names, values not shown):"
  printf '%s\n' "$names" | paste -sd ' ' | fold -s -w 110
  echo
  has() { printf '%s\n' "$names" | grep -qx "$1"; }
  has ELPIDA_PUBLIC_URL || echo "MISSING  ELPIDA_PUBLIC_URL: add ELPIDA_PUBLIC_URL=https://elpida.fun (Railway supplied the domain before)."
  has ELPIDA_BACKUP_ENCRYPTION_KEY || echo "MISSING  ELPIDA_BACKUP_ENCRYPTION_KEY: backups and restores need it."
  printf '%s\n' "$names" | grep -E '^RAILWAY_' | sed 's/^/REMOVE   /; s/$/: set by Railway, not used here./'
  grep -nE '\$\{\{' "$ENVF" | sed -nE 's/^([0-9]+):[[:space:]]*(export[[:space:]]+)?([A-Za-z0-9_]+)=.*/FIX      line \1, \3: still a Railway reference ${{...}}; paste the real value (Railway: Variables -> eye icon)./p'
  grep -nE '^[[:space:]]*ELPIDA_GRADUATION_KEY_FILE=' "$ENVF" >/dev/null && {
    f="$(sed -nE 's/^[[:space:]]*ELPIDA_GRADUATION_KEY_FILE=["'\'']?([^"'\'']*)["'\'']?[[:space:]]*$/\1/p' "$ENVF" | tail -1)"
    [ -r "$f" ] && sudo -u elpida test -r "$f" && echo "ok       ELPIDA_GRADUATION_KEY_FILE points at a file elpida can read." || echo "FIX      ELPIDA_GRADUATION_KEY_FILE: no file there that the elpida user can read (docs/ORACLE_HOSTING.md, step 6)."
  }
else
  echo "MISSING  $ENVF"
fi

echo
echo "Last service messages (lines naming keys, secrets or tokens are hidden):"
journalctl -u elpida -n 15 --no-pager -o cat 2>/dev/null | grep -viE 'key|secret|token|password|mnemonic' | cut -c1-200
