#!/usr/bin/env sh
# Makes tmrkz-images.tar, the one image file of this folder (owner, 19 Nov 2026), on a CONNECTED machine:
#  - tmrkz/folder-backend and tmrkz/folder-web build and run ./backend and ./frontend; they carry the build tools and the
#    dependencies of backend/pom.xml and frontend/package-lock.json, and are proven here to build this folder's source with
#    no network;
#  - the servers: PostgreSQL, Keycloak, OpenFGA, the local directory, nginx.
# Then on any machine, offline, in this folder:   docker load -i tmrkz-images.tar   and   docker compose up -d
# Needed again only when a dependency changes (pom.xml, package-lock.json) or a server image is upgraded.
#   sh ops/local/workspace/pack-images.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../../.."
HERE="$(pwd -W 2>/dev/null || pwd)"
W=ops/local/workspace
BACKEND=tmrkz/folder-backend:1
WEB=tmrkz/folder-web:1
SERVERS="postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine nginx:1.27-alpine"
say() { echo "[pack-images] $*"; }
CTX="$(mktemp -d)"; trap 'rm -rf "$CTX"' EXIT

for img in maven:3.9.16-eclipse-temurin-25 node:24.18.1-alpine $SERVERS; do
  docker image inspect "$img" >/dev/null 2>&1 && continue
  case "$img" in
    tmrkz/keycloak:*) say "building $img"; docker compose -f docker-compose.yml build keycloak ;;
    *) say "pulling $img"; docker pull -q "$img" >/dev/null ;;
  esac
done

say "$BACKEND: Maven and the backend's dependencies"
mkdir -p "$CTX/backend" && cp backend/pom.xml "$CTX/backend/" && cp -r backend/src "$CTX/backend/" && cp "$W/backend-run.sh" "$CTX/backend/"
cat > "$CTX/backend/Dockerfile" <<'EOF'
FROM maven:3.9.16-eclipse-temurin-25
COPY pom.xml /deps/pom.xml
COPY src /deps/src
# the test runner (surefire-junit-platform and the JUnit launcher) is fetched only when a test really runs: two unit tests
# that need no database run once here, so the backend tests (sh ops/test-backend.sh, see its header) also run offline
RUN cd /deps && mvn -B -q dependency:go-offline && mvn -B -q -Dmaven.test.skip=true package \
 && mvn -B -q test -Dtest='HrMappingTest,OidcPropertiesTest' -Dsurefire.failIfNoSpecifiedTests=false && cd / && rm -rf /deps /root/.m2/repository/ae
COPY backend-run.sh /usr/local/bin/tmrkz-backend-run
WORKDIR /workspace
ENTRYPOINT ["sh", "/usr/local/bin/tmrkz-backend-run"]
EOF
tar -C "$CTX/backend" -cf - . | docker build -q -t "$BACKEND" - >/dev/null

say "$WEB: Node and the web's dependencies"
mkdir -p "$CTX/web" && cp frontend/package.json frontend/package-lock.json "$W/web-run.sh" "$CTX/web/"
cat > "$CTX/web/Dockerfile" <<'EOF'
FROM node:24.18.1-alpine
COPY package.json package-lock.json /modules/
RUN cd /modules && npm ci --no-audit --no-fund --loglevel=error && sha256sum < package-lock.json > .package-lock.sha256
COPY web-run.sh /usr/local/bin/tmrkz-web-run
WORKDIR /workspace
ENTRYPOINT ["sh", "/usr/local/bin/tmrkz-web-run"]
EOF
tar -C "$CTX/web" -cf - . | docker build -q -t "$WEB" - >/dev/null

say "proving that both build this folder's source with no network"
docker run --rm --network none -e TMRKZ_BUILD_ONLY=1 -v "$HERE/backend:/workspace/backend:ro" "$BACKEND"
docker run --rm --network none -e TMRKZ_BUILD_ONLY=1 -e VITE_STATIONING_V3=true -v "$HERE/frontend:/workspace/frontend:ro" "$WEB"

say "saving tmrkz-images.tar"
docker save -o tmrkz-images.tar.part "$BACKEND" "$WEB" $SERVERS
mv tmrkz-images.tar.part tmrkz-images.tar
(sha256sum tmrkz-images.tar 2>/dev/null || shasum -a 256 tmrkz-images.tar) > tmrkz-images.tar.sha256
say "ready: tmrkz-images.tar ($(du -h tmrkz-images.tar | cut -f1)) — on the machine: docker load -i tmrkz-images.tar; docker compose up -d"
