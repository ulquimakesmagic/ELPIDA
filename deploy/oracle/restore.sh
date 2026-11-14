#!/usr/bin/env bash
# Restore an off-site backup into the Oracle VM's data folder (docs/ORACLE_HOSTING.md, steps 4 and 6).
#   sudo bash restore.sh list [--from-mirror]          the complete snapshots in the backup bucket, newest last
#   sudo bash restore.sh <snapshot id> [--from-mirror] stop the server, restore, start it again
# The bucket settings and encryption key come from /etc/elpida/elpida.env (ELPIDA_BACKUP_S3_* and
# ELPIDA_BACKUP_ENCRYPTION_KEY, or the ELPIDA_BACKUP_MIRROR_S3_* bucket with --from-mirror). The data that was there
# before is kept in /var/lib/elpida-before-<time> until you delete it.
set -euo pipefail
APP=/opt/elpida/app DATA=/var/lib/elpida
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
[ $# -ge 1 ] || { sed -n '2,7p' "$0"; exit 2; }
id="$1"; shift
mirror=(); [ "${1:-}" = "--from-mirror" ] && mirror=(--from-mirror)

# Node reads the variables file itself (same format as Railway's Raw Editor); nothing is echoed.
backup() { sudo -u elpida bash -c 'cd /opt/elpida/app && exec node --env-file=/etc/elpida/elpida.env scripts/offsite-backup.mjs "$@"' _ "$@"; }

if [ "$id" = list ]; then
  backup review "${mirror[@]}" | jq -r '[.candidates[], .retained[]] | map(select(.manifestPresent)) | sort_by(.createdAt)
    | .[] | "\(.id)  \(.createdAt / 1000 | floor | todate)  \(.bytes / 1048576 | floor) MB"'
  exit 0
fi
[[ "$id" =~ ^ops-[0-9]{13}-[a-f0-9-]{36}$ ]] || { echo "That is not a snapshot id. Run: sudo bash $0 list"; exit 2; }

stamp="$(date -u +%Y%m%d-%H%M%S)"
fresh="/var/lib/elpida-work/restore-$stamp"
install -d -o elpida -g elpida -m 0750 /var/lib/elpida-work
echo "Stopping the server."
systemctl stop elpida
echo "Restoring $id (a few minutes for a large snapshot)."
# offsite-backup.mjs refuses an existing destination, so it restores into a new folder (in elpida's own work folder,
# same disk) that is moved into place afterwards.
result="$(backup restore "$id" "$fresh" "${mirror[@]}")" || { echo "The restore failed; the old data is untouched. Starting the server again."; systemctl start elpida; exit 1; }
# The decrypted working copy is not needed once the files are in place.
tmp="$(printf '%s' "$result" | jq -r '.temporaryDirectory // empty')"
case "$tmp" in "$APP"/backups/offsite-work/restore-*) rm -rf -- "$tmp" ;; esac
if [ -d "$DATA" ] && [ -n "$(ls -A "$DATA")" ]; then mv "$DATA" "/var/lib/elpida-before-$stamp"; echo "Previous data kept in /var/lib/elpida-before-$stamp."; else rm -rf -- "$DATA"; fi
mv "$fresh" "$DATA"
chown -R elpida:elpida "$DATA"; chmod 0750 "$DATA"
echo "Restored $(printf '%s' "$result" | jq -r '.files') files. Starting the server."
systemctl start elpida
echo "Chain indexes left out of the backup rebuild from the chain over the next minutes. Check: sudo bash $APP/deploy/oracle/doctor.sh"
