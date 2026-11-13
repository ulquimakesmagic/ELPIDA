#!/usr/bin/env bash
# shellcheck disable=SC1090  # the staging file path is chosen at run time
# systemd's ExecStart for Elpida on Oracle Cloud. /etc/elpida/elpida.env is already loaded; the hosting values below
# always win, so a PORT or HOST copied from Railway cannot open the server to the internet.
#
# Staging: while /etc/elpida/staging.env exists, this server is a second copy next to Railway. It must not sign
# anything or write backups, so the keeper, relay and Circle keys are removed and backups are off. staging.env holds
# ELPIDA_PUBLIC_URL=https://staging.elpida.fun. Delete the file at cut-over (docs/ORACLE_HOSTING.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
staging="${ELPIDA_STAGING_FILE:-/etc/elpida/staging.env}"
if [ -f "$staging" ]; then
  unset ELPIDA_GRADUATION_KEY_FILE ELPIDA_TESTNET_RELAY_KEY ELPIDA_V2_KEEPER_KEY ELPIDA_V2_KEEPER_SOLANA_KEY \
        CIRCLE_API_KEY CIRCLE_ENTITY_SECRET CIRCLE_WALLET_SET_ID ELPIDA_CANONICAL_ORIGIN
  set -a; . "$staging"; set +a
  export ELPIDA_BACKUP_ENABLED=false
  echo '{"event":"staging_mode","keepers":"off","backups":"off"}'
fi
export NODE_ENV=production HOST=127.0.0.1 PORT=3000 ELPIDA_DATA_DIR=/var/lib/elpida \
       ELPIDA_BACKUP_WORK_DIR=/var/lib/elpida-work ELPIDA_TRUST_PROXY=cloudflare
exec "${ELPIDA_NODE:-node}" apps/api/server.mjs
