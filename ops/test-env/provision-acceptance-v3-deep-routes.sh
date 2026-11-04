#!/usr/bin/env sh
# Fictional ACCEPTANCE accounts and seats for Stationing V3 routes from L8, L9 and L10 on tmrkz-test (owner, 4 Nov 2026):
# four directory accounts (ldap/acceptance-v3-deep-routes.ldif) and their fictional HR people, affiliations and
# single-action roles (acceptance-v3-deep-routes.sql). Refuses the owner-retained project and any database not labelled
# ACCEPTANCE.
#
#   sh ops/test-env/provision-acceptance-v3-deep-routes.sh                          # plan (rolled back), exit 3
#   CONFIRM_TARGET=tmrkz-test sh ops/test-env/provision-acceptance-v3-deep-routes.sh  # write it (idempotent)
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
echo "[deep-routes] target $DB: $IDENT"
docker exec -i "$DB" psql -X -q -U mover -d mover -At -v apply="$APPLY" -f - < ops/test-env/acceptance-v3-deep-routes.sql
if [ "$APPLY" != on ]; then
  echo "[deep-routes] plan only (rolled back); the directory is not changed: set CONFIRM_TARGET=$P to write"
  exit 3
fi
G=ops/test-env/.generated
ADMIN_PW="$(cat "$G/ldap-admin-password")"
sed "s/__PASSWORD__/$(cat "$G/user-password")/" ops/test-env/ldap/acceptance-v3-deep-routes.ldif \
  | docker exec -i "$LDAP" ldapadd -c -x -H ldap://localhost -D "cn=admin,dc=tmrkz,dc=test" -w "$ADMIN_PW" 2>&1 \
  | grep -E "adding new entry|Already exists|error" || true
FOUND="$(docker exec "$LDAP" ldapsearch -x -H ldap://localhost -D "cn=admin,dc=tmrkz,dc=test" -w "$ADMIN_PW" \
  -b ou=people,dc=tmrkz,dc=test "(|(uid=t.requester.pm)(uid=t.seat.l8)(uid=t.seat.l9)(uid=t.seat.l10))" uid 2>/dev/null | grep -c '^uid:' || true)"
echo "[deep-routes] directory accounts present: $FOUND of 4"
echo "[deep-routes] written"
