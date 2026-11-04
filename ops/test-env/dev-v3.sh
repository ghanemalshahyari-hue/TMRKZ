#!/usr/bin/env sh
# DEVELOPMENT environment for the Stationing V3 work in progress — disposable, fictional data only, never the acceptance
# (tmrkz-test) or production (tmrkz-mover) project. Project tmrkz-v3dev on :8097 with the fictional directory, HR mirror
# and facilities of the acceptance environment, the backend built from the WORKING TREE (not a release), memory-capped
# because the Docker VM is shared. Its database is created fresh and migrated to whatever the working tree holds.
#
#   sh ops/test-env/dev-v3.sh build   # backend image mover/backend:v3-dev from the working tree
#   sh ops/test-env/dev-v3.sh up      # start (or update the backend of) the environment
#   sh ops/test-env/dev-v3.sh seed    # fictional development values for Stationing V3 (ops/test-env/dev-v3-seed.sql)
#   sh ops/test-env/dev-v3.sh down    # remove it with its volumes
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P=tmrkz-v3dev
PORT=8097
IMAGE=mover/backend:v3-dev
. ops/test-env/prepare.sh
export MOVER_HTTP_PORT="$PORT" TMRKZ_PUBLIC_URL="http://localhost:$PORT" MOVER_URL="http://localhost:$PORT"
OVR="$G/dev-v3.override.yml"
printf 'services:\n  backend:\n    image: %s\n    mem_limit: 1536m\n  keycloak:\n    mem_limit: 1g\n' "$IMAGE" > "$OVR"
compose() {
  docker compose -p "$P" -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml -f "$OVR" "$@"
}
case "${1:-up}" in
  build)
    tar cf - backend/pom.xml backend/src backend/Dockerfile map-packages \
      | docker build -q -f backend/Dockerfile -t "$IMAGE" --label org.opencontainers.image.source="working tree (development, not a release)" -
    ;;
  up)
    compose up -d --no-build
    i=0
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/api/v1/auth/status")" = 200 ]; do
      i=$((i + 1)); [ $i -gt 120 ] && { echo "[dev-v3] not ready"; exit 1; }; sleep 3
    done
    echo "[dev-v3] up on $MOVER_URL (fictional users: ops/test-env/README.md; password: $G/user-password)"
    ;;
  seed)
    compose exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -q -f - < ops/test-env/dev-v3-seed.sql
    echo "[dev-v3] Stationing V3 development values seeded"
    ;;
  down)
    compose down -v
    ;;
  *) echo "usage: sh ops/test-env/dev-v3.sh build|up|seed|down" >&2; exit 2;;
esac
