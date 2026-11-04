#!/usr/bin/env sh
# Fictional ACCEPTANCE performance fixtures for Stationing V3 geometry editing on tmrkz-test (owner, 4 Nov 2026): a
# four-part MultiPolygon site and a polygon site of about 1,500 vertices, each the current site of a new fictional local
# section of «قسم مشاريع المباني» (acceptance-v3-geometry.sql). Refuses the owner-retained project, any database not
# labelled ACCEPTANCE and any schema other than V20. Idempotent: a second run reports total_changes = 0.
#
#   sh ops/test-env/provision-acceptance-v3-geometry.sh                          # plan (rolled back), exit 3
#   CONFIRM_TARGET=tmrkz-test sh ops/test-env/provision-acceptance-v3-geometry.sh  # write it
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P="${P:-tmrkz-test}"
case "$P" in tmrkz-mover|tmrkz-mover-*) echo "refused: $P is the owner-retained production project" >&2; exit 2;; esac
DB="$P-db-1"
[ "$(docker inspect -f '{{.State.Running}}' "$DB" 2>/dev/null || true)" = "true" ] || { echo "no running database $DB" >&2; exit 2; }
IDENT="$(docker exec "$DB" psql -U mover -d mover -At -c "select shobj_description(oid, 'pg_database') from pg_database where datname = 'mover'")"
case "$IDENT" in ACCEPTANCE*) ;; *) echo "refused: $P is not labelled ACCEPTANCE" >&2; exit 2;; esac
APPLY=off
[ "${CONFIRM_TARGET:-}" = "$P" ] && APPLY=on
echo "[geometry-fixtures] target $DB: $IDENT"
docker exec -i "$DB" psql -X -q -U mover -d mover -At -v apply="$APPLY" -f - < ops/test-env/acceptance-v3-geometry.sql
if [ "$APPLY" != on ]; then
  echo "[geometry-fixtures] plan only (rolled back): set CONFIRM_TARGET=$P to write"
  exit 3
fi
echo "[geometry-fixtures] written"
