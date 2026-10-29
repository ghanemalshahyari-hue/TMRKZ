#!/usr/bin/env sh
# Runs the backend acceptance suite against a throw-away PostgreSQL container (no JDK needed on the host).
# Usage: ops/test-backend.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
NET=mover-test-net
PG=mover-test-pg
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" --network "$NET" -e POSTGRES_DB=mover_test -e POSTGRES_USER=mover -e POSTGRES_PASSWORD=devpass \
  postgres:17.11-alpine >/dev/null
until docker exec "$PG" pg_isready -U mover -d mover_test >/dev/null 2>&1; do sleep 1; done
sleep 2
status=0
HOST_DIR="$(pwd -W 2>/dev/null || pwd)"
docker run --rm --network "$NET" -v mover-m2:/root/.m2 -v "$HOST_DIR:/repo" -w /repo/backend \
  -e MOVER_TEST_DB_URL="jdbc:postgresql://$PG:5432/mover_test" maven:3.9.16-eclipse-temurin-25 mvn -B test || status=$?
docker rm -f "$PG" >/dev/null
docker network rm "$NET" >/dev/null 2>&1 || true
exit $status
