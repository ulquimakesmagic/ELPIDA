#!/usr/bin/env bash
# Deploy the latest main (or a given commit) on the Oracle VM, and roll back by itself if it does not come up.
#   sudo bash /opt/elpida/app/deploy/oracle/update.sh            # origin/main
#   sudo bash /opt/elpida/app/deploy/oracle/update.sh <commit>   # a specific commit, e.g. to go back
#   update.sh --auto                                              # elpida-update.timer, every 5 minutes: deploys a new
#                                                                 # main like Railway did, skips a commit that failed
set -euo pipefail
APP=/opt/elpida/app ETC=/etc/elpida FAILED=/var/lib/elpida-work/update-failed

# Everything runs inside main(), which bash reads whole before running: checking out a new commit rewrites this file.
main() {
  [ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }
  cd "$APP"
  local auto=0 ref target previous
  [ "${1:-}" = "--auto" ] && { auto=1; shift; }
  git_ fetch --quiet origin
  ref="${1:-origin/main}"
  target="$(git_ rev-parse --verify "$ref^{commit}")"
  previous="$(git_ rev-parse HEAD)"
  # Automatic runs only act on a new commit (a stopped server is systemd's job); by hand, the same commit restarts it.
  if [ "$target" = "$previous" ] && { [ "$auto" = 1 ] || systemctl is-active --quiet elpida; }; then
    [ "$auto" = 1 ] || echo "Already on ${target:0:12}."
    exit 0
  fi
  # Not before the server is set up and running (step 4 of docs/ORACLE_HOSTING.md).
  if [ "$auto" = 1 ] && ! systemctl is-active --quiet elpida; then exit 0; fi
  if [ "$auto" = 1 ] && [ -f "$FAILED" ] && grep -qx "$target" "$FAILED"; then exit 0; fi

  echo "Deploying ${target:0:12} (was ${previous:0:12})."
  deploy "$target"
  if healthy "$target"; then echo "Healthy on ${target:0:12}."; exit 0; fi
  echo "$target" >> "$FAILED"
  echo "No healthy answer within 5 minutes. Rolling back to ${previous:0:12}; ${target:0:12} will not be retried automatically."
  journalctl -u elpida -n 40 --no-pager -o cat | grep -viE 'key|secret|token|password|mnemonic' || true
  deploy "$previous"
  if healthy "$previous"; then echo "Rolled back; ${previous:0:12} is serving."; else echo "The rollback is not healthy either: run doctor.sh."; fi
  exit 1
}

git_() { sudo -u elpida git -C "$APP" "$@"; }

deploy() {
  local commit="$1" before
  before="$(git_ rev-parse HEAD)"
  git_ checkout --quiet --detach "$commit"
  if [ ! -d node_modules ] || { [ "$commit" != "$before" ] && ! git_ diff --quiet "$before" "$commit" -- package-lock.json; }; then
    sudo -H -u elpida npm ci --omit=dev --no-audit --no-fund
  fi
  # The unit files may change with the code.
  local changed=0 f
  for f in elpida.service elpida-update.service elpida-update.timer; do
    if ! cmp -s "deploy/oracle/$f" "/etc/systemd/system/$f"; then install -m 0644 "deploy/oracle/$f" "/etc/systemd/system/$f"; changed=1; fi
  done
  [ "$changed" = 1 ] && systemctl daemon-reload
  echo "ELPIDA_BUILD=$commit" > "$ETC/build.env"
  systemctl restart elpida
}

healthy() {
  local want="${1:0:12}" body
  for _ in $(seq 1 60); do
    sleep 5
    body="$(curl -fsS --max-time 5 http://127.0.0.1:3000/health 2>/dev/null || true)"
    [ "$(printf '%s' "$body" | jq -r '.build // empty' 2>/dev/null)" = "$want" ] && return 0
  done
  return 1
}

main "$@"
exit
