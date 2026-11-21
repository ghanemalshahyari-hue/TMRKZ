#!/usr/bin/env sh
# Stops the synthetic enterprise directory (ops/hr-demo/synthetic-ad/up.sh). The directory's data stays in its volumes, so
# up.sh brings the same accounts back; --wipe removes the volumes as well (the CA, certificate and passwords in
# ops/hr-demo/.generated stay).
#   sh ops/hr-demo/synthetic-ad/down.sh [--wipe]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
ENV=../.generated/synthetic-ad.env
[ -f "$ENV" ] || { echo "[synthetic-ad] nothing was started here (no $ENV)"; exit 0; }
if [ "${1:-}" = "--wipe" ]; then
  docker compose -p tmrkz-synthetic-ad --profile synthetic-enterprise --env-file "$ENV" -f compose.yml down -v
  echo "[synthetic-ad] stopped and the directory's data removed"
else
  docker compose -p tmrkz-synthetic-ad --profile synthetic-enterprise --env-file "$ENV" -f compose.yml down
  echo "[synthetic-ad] stopped (data kept; --wipe removes it)"
fi
