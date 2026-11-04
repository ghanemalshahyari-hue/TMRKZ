#!/usr/bin/env sh
# Fictional ACCEPTANCE accounts holding the Stationing V3 lifecycle rights on tmrkz-test (owner, 4 Nov 2026; ADR-034):
# four directory accounts (ldap/acceptance-v3-lifecycle.ldif) and their fictional HR people, affiliations and
# single-action roles (acceptance-v3-lifecycle.sql). Refuses the owner-retained project and any database not labelled
# ACCEPTANCE.
#
#   sh ops/test-env/provision-acceptance-v3-lifecycle.sh                          # plan (rolled back), exit 3
#   CONFIRM_TARGET=tmrkz-test sh ops/test-env/provision-acceptance-v3-lifecycle.sh  # write it (idempotent)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P="${P:-tmrkz-test}"
case "$P" in tmrkz-mover|tmrkz-mover-*) echo "refused: $P is the owner-retained production project" >&2; exit 2;; esac
DB="$P-db-1"
LDAP="$P-openldap-1"
[ "$(docker inspect -f '{{.State.Running}}' "$DB" 2>/dev/null || true)" = "true" ] || { echo "no running database $DB" >&2; exit 2; }
IDENT="$(docker exec "$DB" psql -U mover -d mover -At -c "select shobj_description(oid, 'pg_database') from pg_database where datname = 'mover'")"
case "$IDENT" in ACCEPTANCE*) ;; *) echo "refused: $P is not labelled ACCEPTANCE" >&2; exit 2;; esac
APPLY=off
[ "${CONFIRM_TARGET:-}" = "$P" ] && APPLY=on
echo "[lifecycle] target $DB: $IDENT"
docker exec -i "$DB" psql -X -q -U mover -d mover -At -v apply="$APPLY" -f - < ops/test-env/acceptance-v3-lifecycle.sql
if [ "$APPLY" != on ]; then
  echo "[lifecycle] plan only (rolled back); the directory is not changed: set CONFIRM_TARGET=$P to write"
  exit 3
fi
G=ops/test-env/.generated
ADMIN_PW="$(cat "$G/ldap-admin-password")"
sed "s/__PASSWORD__/$(cat "$G/user-password")/" ops/test-env/ldap/acceptance-v3-lifecycle.ldif \
  | docker exec -i "$LDAP" ldapadd -c -x -H ldap://localhost -D "cn=admin,dc=tmrkz,dc=test" -w "$ADMIN_PW" 2>&1 \
  | grep -E "adding new entry|Already exists|error" || true
FOUND="$(docker exec "$LDAP" ldapsearch -x -H ldap://localhost -D "cn=admin,dc=tmrkz,dc=test" -w "$ADMIN_PW" \
  -b ou=people,dc=tmrkz,dc=test "(|(uid=t.lc.cancel)(uid=t.lc.start)(uid=t.lc.return)(uid=t.lc.ext))" uid 2>/dev/null | grep -c '^uid:' || true)"
echo "[lifecycle] directory accounts present: $FOUND of 4"
echo "[lifecycle] written"
