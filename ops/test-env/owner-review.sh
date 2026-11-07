#!/usr/bin/env sh
# The owner's morning review of the complete request phase (ADR-045): a SEPARATE disposable environment, project tmrkz-next on
# :8096, with its own images (mover/backend:next, mover/web:next) so the retained project tmrkz-mover and its image tags are
# never touched. Fictional organisations, people and sites; the terrain is the real GLO-30 analysis. Its database is created
# fresh and migrated to the working tree, V30 included. Never a retained or production environment.
#
#   sh ops/test-env/owner-review.sh up      # build, start, seed
#   sh ops/test-env/owner-review.sh seed    # fictional data, terrain and policy again (idempotent)
#   sh ops/test-env/owner-review.sh down    # remove it with its volumes
# Passwords: ops/test-env/.generated/user-password (git-ignored).
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P=tmrkz-next
PORT=8096
. ops/test-env/prepare.sh
export MOVER_HTTP_PORT="$PORT" TMRKZ_PUBLIC_URL="http://localhost:$PORT" MOVER_URL="http://localhost:$PORT" TMRKZ_STATIONING_V3=true TMRKZ_FLOW_STUDIO_UI=true TMRKZ_MAP_ROOT="${TMRKZ_MAP_ROOT:-./map-runtime}"
export TERRAIN_VERSION="${TERRAIN_VERSION:-2026.11-dev-unverified}"
OVR="$G/owner-review.override.yml"
printf 'services:\n  backend:\n    image: mover/backend:next\n  web:\n    image: mover/web:next\n' > "$OVR"
compose() {
  docker compose -p "$P" -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml -f "$OVR" "$@"
}
seed() {
  compose exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -q -f - < ops/test-env/owner-review-seed.sql
  # The local terrain files are a rebuild whose checksums differ from the approved record (docs/STATUS.md), so here they load
  # with NO manifest and under a version that says so: they cannot be mistaken for the approved dataset. Real GLO-30, development only.
  # the loader's plan needs rasterio, which the terrain tools image holds (ops/terrain/requirements.txt)
  if ! python -c 'import rasterio' >/dev/null 2>&1; then
    mkdir -p "$G/bin"
    printf '#!/bin/sh\nexec docker run --rm -v "$PWD":/src -w /src tmrkz-terrain-tools:dev python "$@"\n' > "$G/bin/python"
    chmod +x "$G/bin/python"
    PATH="$PWD/$G/bin:$PATH"; export PATH
  fi
  TERRAIN_MANIFEST=/nonexistent/no-manifest CONFIRM_TARGET="$P" sh ops/terrain/load-slope.sh "$P" "$TERRAIN_VERSION" > "$G/terrain-load.log" 2>&1 || { tail -5 "$G/terrain-load.log"; exit 1; }
  tail -1 "$G/terrain-load.log"
  node tests/acceptance/owner-review-setup.mjs
  compose exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -q -f - < ops/test-env/owner-review-areas.sql
}
case "${1:-up}" in
  up)
    compose up -d --build
    i=0
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/api/v1/auth/status")" = 200 ]; do
      i=$((i + 1)); [ $i -gt 200 ] && { echo "[owner-review] not ready"; exit 1; }; sleep 3
    done
    i=0
    until [ "$(docker inspect -f '{{.State.Status}}' "$P-test-seed-1" 2>/dev/null)" = exited ]; do
      i=$((i + 1)); [ $i -gt 100 ] && { echo "[owner-review] seed not finished"; exit 1; }; sleep 3
    done
    seed
    echo "[owner-review] up on $MOVER_URL — guide: docs/evidence/stationing-next/OWNER_TEST_GUIDE_AR.md; password: $G/user-password"
    ;;
  seed) seed ;;
  down) compose down -v ;;
  *) echo "usage: sh ops/test-env/owner-review.sh up|seed|down" >&2; exit 2 ;;
esac
