#!/usr/bin/env sh
# Restarts the acceptance environment without internet egress (internal-only Docker network; web published through a
# separate network) and checks that the backend cannot reach an external address. Data volumes are kept.
# Usage: sh ops/test-env/up-offline.sh   (then: node tests/acceptance/map-workspace.mjs)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
. ops/test-env/prepare.sh
FILES="-f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml -f ops/test-env/compose.offline.yml"
docker compose -p tmrkz-test $FILES down
docker compose -p tmrkz-test $FILES up -d --build "$@"
until [ "$(docker inspect -f '{{.State.Health.Status}}' tmrkz-test-web-1 2>/dev/null)" = "healthy" ]; do sleep 2; done
if docker exec tmrkz-test-backend-1 wget -q -T 5 -O /dev/null https://example.org 2>/dev/null; then
  echo "[offline] FAIL: the backend reached the internet" >&2
  exit 1
fi
echo "[offline] PASS: backend has no route to the internet; web published on ${TMRKZ_PUBLIC_URL:-http://localhost:8088}"
