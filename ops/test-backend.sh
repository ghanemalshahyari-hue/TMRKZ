#!/usr/bin/env sh
# Runs the backend acceptance suite against throw-away PostgreSQL + PostGIS and OpenFGA containers (no JDK needed on the
# host). Usage: ops/test-backend.sh                 (whole suite)
#               ops/test-backend.sh AccessAcceptanceIT,AuthorizationIT   (only the classes affected by a change)
# Offline: TMRKZ_TEST_MAVEN_IMAGE and TMRKZ_TEST_MAVEN_VOLUME may name an approved local builder and populated cache.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
NET=mover-test-net
PG=mover-test-pg
FGA=mover-test-openfga
FGA_KEY=test-openfga-preshared-key
IMAGE="${TMRKZ_TEST_MAVEN_IMAGE:-maven:3.9.16-eclipse-temurin-25}"
CACHE="${TMRKZ_TEST_MAVEN_VOLUME:-mover-m2}"
# No attempt to repair a missing offline toolchain by downloading it: fail before creating any test resources.
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "Offline backend tests need the approved local Maven/Java 25 builder image: $IMAGE" >&2
  echo "Provide it through images/ or TMRKZ_TEST_MAVEN_IMAGE; no pull is attempted." >&2
  exit 2
}
docker volume inspect "$CACHE" >/dev/null 2>&1 || {
  echo "Offline backend tests need the populated Maven dependency cache volume: $CACHE" >&2
  echo "Provide it through the approved local channel or TMRKZ_TEST_MAVEN_VOLUME; no download is attempted." >&2
  exit 2
}
docker run --rm --pull never --network none -v "$CACHE:/root/.m2:ro" --entrypoint sh "$IMAGE" \
  -c 'test -d /root/.m2/repository/org/springframework/boot' >/dev/null 2>&1 || {
  echo "The Maven cache $CACHE does not contain the expected Spring Boot dependencies under /root/.m2/repository." >&2
  exit 2
}
CREATED_NET=""
if docker network inspect "$NET" >/dev/null 2>&1; then
  [ "$(docker network inspect -f '{{.Internal}}' "$NET")" = true ] || {
    echo "$NET already exists with external egress; remove that disposable test network before the offline run." >&2
    exit 2
  }
else
  docker network create --internal "$NET" >/dev/null
  CREATED_NET=yes
fi
cleanup() {
  docker rm -f "$PG" "$FGA" >/dev/null 2>&1 || true
  [ -z "$CREATED_NET" ] || docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker rm -f "$PG" "$FGA" >/dev/null 2>&1 || true
docker run -d --pull never --name "$FGA" --network "$NET" openfga/openfga:v1.8.16 run --datastore-engine memory \
  --authn-method preshared --authn-preshared-keys "$FGA_KEY" --playground-enabled=false --log-level warn >/dev/null
# every cached Spring test context keeps its own connection pool; V17MigrationIT and V47MigrationIT also open probe databases
docker run -d --pull never --name "$PG" --network "$NET" -e POSTGRES_DB=mover_test -e POSTGRES_USER=mover -e POSTGRES_PASSWORD=devpass \
  postgis/postgis:17-3.5-alpine -c max_connections=500 >/dev/null
until docker exec "$PG" pg_isready -U mover -d mover_test >/dev/null 2>&1; do sleep 1; done
sleep 2
HOST_DIR="$(pwd -W 2>/dev/null || pwd)"
docker run --rm --pull never --network "$NET" -v "$CACHE:/root/.m2" -v "$HOST_DIR:/repo" -w /repo/backend \
  -e MOVER_TEST_DB_URL="jdbc:postgresql://$PG:5432/mover_test" \
  -e MOVER_TEST_FGA_URL="http://$FGA:8080" -e MOVER_TEST_FGA_KEY="$FGA_KEY" \
  "$IMAGE" mvn -B -o test ${1:+-Dtest="$1" -Dsurefire.failIfNoSpecifiedTests=false}
