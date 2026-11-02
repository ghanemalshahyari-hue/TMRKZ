#!/usr/bin/env sh
# Disposable load environment (never production, never the acceptance environment): TMRKZ with the fictional directory
# and data of ops/test-env, as compose project tmrkz-load on its own port and volumes, plus synthetic accounts that sign
# in through the supported directory flow. The accounts share one generated password, kept under
# ops/test-env/.generated/load-password (git-ignored).
# Usage: COUNT=50 sh ops/load/up-load-env.sh      then: node ops/load/load-test.mjs (see its header)
#        DOWN=1 sh ops/load/up-load-env.sh        removes the project and its volumes
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
. ops/test-env/prepare.sh
PORT="${LOAD_HTTP_PORT:-8099}"
COUNT="${COUNT:-50}"
export MOVER_HTTP_PORT="$PORT" TMRKZ_PUBLIC_URL="http://localhost:$PORT"
P=tmrkz-load
compose() { docker compose -p "$P" -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml "$@"; }
if [ "${DOWN:-0}" = 1 ]; then
  compose down -v
  exit 0
fi
compose up -d --build
until [ "$(docker inspect -f '{{.State.Status}}' "$P-test-seed-1" 2>/dev/null)" = "exited" ]; do sleep 3; done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$P-test-seed-1")" = 0 ] || { echo "[load] fictional seed failed"; exit 1; }

[ -f "$G/load-password" ] || printf 'Load-%s' "$(rand 16)" > "$G/load-password"
LDIF="$G/load-people.ldif"
: > "$LDIF"
entry() {
  printf 'dn: uid=%s,ou=people,dc=tmrkz,dc=test\nobjectClass: inetOrgPerson\nuid: %s\ncn: %s\nsn: Load\nemployeeNumber: %s\nuserPassword: %s\n\n' \
    "$1" "$1" "$1" "$2" "$(cat "$G/load-password")" >> "$LDIF"
}
i=1
while [ "$i" -le "$COUNT" ]; do
  n=$(printf '%04d' "$i")
  entry "load.$n" "LOAD-$n"
  i=$((i + 1))
done
entry load.r.fac LOAD-R-FAC
entry load.r.mgr LOAD-R-MGR
entry load.r.apr LOAD-R-APR
# -c: accounts kept from an earlier run are left as they are
docker exec -i "$P-openldap-1" ldapadd -c -x -H ldap://localhost -D "cn=admin,dc=tmrkz,dc=test" -w "$TEST_LDAP_ADMIN_PASSWORD" \
  < "$LDIF" > /dev/null 2>&1 || true
rm -f "$LDIF"
docker exec -i "$P-db-1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v ON_ERROR_STOP=1 -v count='"$COUNT" \
  < ops/load/synthetic-identities.sql
echo "[load] tmrkz-load ready on http://localhost:$PORT with $COUNT synthetic requesters and 3 reviewers"
