#!/usr/bin/env sh
# Fictional ACCEPTANCE data for Stationing V3 on tmrkz-test (owner decision D4, 4 Nov 2026): HR levels, approver seats
# and the three Stationing V3 actions for selected fictional users, starting stationing, a missing site boundary.
# No policy is published and no terrain is loaded here (ops/terrain/load-slope.sh is its own operation).
#
#   sh ops/test-env/provision-acceptance-v3.sh                          # plan: what would be written (rolled back), exit 3
#   CONFIRM_TARGET=tmrkz-test sh ops/test-env/provision-acceptance-v3.sh  # write it (idempotent)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P="${P:-tmrkz-test}"
case "$P" in tmrkz-mover|tmrkz-mover-*) echo "refused: $P is the owner-retained production project" >&2; exit 2;; esac
DB="$P-db-1"
[ "$(docker inspect -f '{{.State.Running}}' "$DB" 2>/dev/null || true)" = "true" ] || { echo "no running database $DB" >&2; exit 2; }
APPLY=off
[ "${CONFIRM_TARGET:-}" = "$P" ] && APPLY=on
echo "[acceptance-v3] target $DB, database comment: $(docker exec "$DB" psql -U mover -d mover -At -c "select shobj_description(oid, 'pg_database') from pg_database where datname = 'mover'")"
docker exec -i "$DB" psql -X -q -U mover -d mover -At -v apply="$APPLY" -f - < ops/test-env/acceptance-v3-provision.sql
if [ "$APPLY" = on ]; then
  echo "[acceptance-v3] written"
else
  echo "[acceptance-v3] plan only (rolled back): set CONFIRM_TARGET=$P to write"
  exit 3
fi
