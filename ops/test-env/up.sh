#!/usr/bin/env sh
# Starts TMRKZ with the acceptance test environment: a fictional directory (OpenLDAP, StartTLS, test CA) and fictional
# HR mirror, people, grants and facilities. Never use this in production.
# Usage: sh ops/test-env/up.sh   (compose project tmrkz-test, own volumes; sign in at TMRKZ_PUBLIC_URL, default :8088)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
. ops/test-env/prepare.sh
docker compose -p tmrkz-test -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml up -d --build "$@"
echo "Test environment up. Fictional users and the shared password: ops/test-env/README.md and $G/user-password"
