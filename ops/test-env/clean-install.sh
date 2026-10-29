#!/usr/bin/env sh
# Clean installation, from an empty database, without the fictional data of tmrkz-test: only TMRKZ, Keycloak and a
# fictional directory to sign in against. Proves the first-administrator path (ops/bootstrap-admin.sh) and the first
# configuration steps, then removes the project. Set KEEP=1 to leave it running for inspection.
# Usage: sh ops/test-env/clean-install.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
. ops/test-env/prepare.sh
export MOVER_HTTP_PORT=8098 TMRKZ_PUBLIC_URL=http://localhost:8098 MOVER_URL=http://localhost:8098
P=tmrkz-clean
compose() { docker compose -p "$P" -f docker-compose.yml -f ops/test-env/compose.directory.yml "$@"; }
cleanup() { [ "${KEEP:-0}" = 1 ] || compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
compose down -v >/dev/null 2>&1 || true
compose up -d --build >/dev/null 2>&1
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] \
   && [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/api/v1/auth/status")" = 200 ]; do
  i=$((i + 1)); [ $i -gt 100 ] && { echo "clean installation did not become ready"; exit 1; }; sleep 3
done
node tests/acceptance/clean-install.mjs "$P"
