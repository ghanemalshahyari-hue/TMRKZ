#!/usr/bin/env sh
# Runs the backend acceptance suite against throw-away PostgreSQL + PostGIS and OpenFGA containers (no JDK needed on the
# host). Usage: ops/test-backend.sh                 (whole suite)
#               ops/test-backend.sh AccessAcceptanceIT,AuthorizationIT   (only the classes affected by a change)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
NET=mover-test-net
PG=mover-test-pg
FGA=mover-test-openfga
FGA_KEY=test-openfga-preshared-key
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f "$PG" "$FGA" >/dev/null 2>&1 || true
docker run -d --name "$FGA" --network "$NET" openfga/openfga:v1.8.16 run --datastore-engine memory \
  --authn-method preshared --authn-preshared-keys "$FGA_KEY" --playground-enabled=false --log-level warn >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_DB=mover_test -e POSTGRES_USER=mover -e POSTGRES_PASSWORD=devpass \
  postgis/postgis:17-3.5-alpine >/dev/null
until docker exec "$PG" pg_isready -U mover -d mover_test >/dev/null 2>&1; do sleep 1; done
sleep 2
status=0
HOST_DIR="$(pwd -W 2>/dev/null || pwd)"
docker run --rm --network "$NET" -v mover-m2:/root/.m2 -v "$HOST_DIR:/repo" -w /repo/backend \
  -e MOVER_TEST_DB_URL="jdbc:postgresql://$PG:5432/mover_test" \
  -e MOVER_TEST_FGA_URL="http://$FGA:8080" -e MOVER_TEST_FGA_KEY="$FGA_KEY" \
  maven:3.9.16-eclipse-temurin-25 mvn -B test ${1:+-Dtest="$1" -Dsurefire.failIfNoSpecifiedTests=false} || status=$?
docker rm -f "$PG" "$FGA" >/dev/null
docker network rm "$NET" >/dev/null 2>&1 || true
exit $status
