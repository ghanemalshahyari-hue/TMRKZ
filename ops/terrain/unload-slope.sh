#!/usr/bin/env sh
# Removes one terrain slope dataset (terrain_dataset row and its terrain_slope tiles) from PostGIS, so it can be rebuilt
# or replaced independently of the migration and of every Stationing business record (owner, 4 Nov 2026).
#
#   sh ops/terrain/unload-slope.sh <container|compose-project> <dataset-version>          # PLAN only (dry run), exit 3
#   CONFIRM_TARGET=<same target> sh ops/terrain/unload-slope.sh <target> <dataset-version>  # remove
#
# Nothing references a dataset except its tiles: requests and audit keep the dataset code, version and product checksum
# as values, so removing a dataset never changes a stored decision. The removal is one transaction that counts the
# Stationing business tables (policy versions, stationing, site links, outbox) and the audit log before and after and
# rolls back if any count differs. It is refused while the policy version in force, or one scheduled after it, names
# the dataset (submissions would then fail the terrain assessment), unless ALLOW_POLICY_REFERENCE=1, which is meant for
# removing and reloading the same product. The owner-retained production project is refused.
# Env: TERRAIN_CODE (copernicus-glo30), PGDATABASE, PGUSER.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
TARGET="${1:-}"
VERSION="${2:-}"
if [ -z "$TARGET" ] || [ -z "$VERSION" ]; then
  echo "usage: [CONFIRM_TARGET=<target>] sh ops/terrain/unload-slope.sh <container|compose-project> <dataset-version>" >&2
  exit 2
fi
CODE="${TERRAIN_CODE:-copernicus-glo30}"
DB="${PGDATABASE:-mover}"
DBUSER="${PGUSER:-mover}"
case "$TARGET" in tmrkz-mover|tmrkz-mover-*) echo "[terrain] refused: $TARGET is the owner-retained production project" >&2; exit 2;; esac

if [ "$(docker inspect -f '{{.State.Running}}' "$TARGET" 2>/dev/null || true)" = "true" ]; then
  psql_t() { docker exec -i "$TARGET" psql -X -q -v ON_ERROR_STOP=1 -U "$DBUSER" -d "$DB" "$@"; }
  KIND=container
elif [ -n "$(docker compose -p "$TARGET" ps -q db 2>/dev/null || true)" ]; then
  psql_t() { docker compose -p "$TARGET" exec -T db psql -X -q -v ON_ERROR_STOP=1 -U "$DBUSER" -d "$DB" "$@"; }
  KIND="compose project (service db)"
else
  echo "[terrain] no running container or compose project db named '$TARGET'" >&2
  exit 2
fi

FOUND="$(psql_t -At -F ' ' -c "select d.slope_sha256, count(t.rid) from terrain_dataset d left join terrain_slope t on t.dataset_id = d.id
  where d.code = '$CODE' and d.version = '$VERSION' group by d.id, d.slope_sha256")"
# the policy version in force and any scheduled after it (a newer version supersedes, see StationingPolicyStore)
REFS="$(psql_t -At -c "select string_agg(v.version::text, ',' order by v.version) from stationing_policy_version v
  where v.version >= coalesce((select max(version) from stationing_policy_version where effective_from <= now()), 0)
    and v.policy_values->'terrainSlopeClassification'->>'datasetCode' = '$CODE'
    and v.policy_values->'terrainSlopeClassification'->>'datasetVersion' = '$VERSION'")"

echo "[terrain] removal plan"
echo "  target          : $TARGET ($KIND), database $DB"
echo "  dataset         : $CODE $VERSION"
echo "  loaded          : ${FOUND:-no} (product sha256, tiles)"
echo "  policy versions : ${REFS:-none} in force or scheduled name it"
[ -n "$FOUND" ] || { echo "[terrain] $CODE $VERSION is not loaded; nothing to do"; exit 0; }
if [ -n "$REFS" ] && [ "${ALLOW_POLICY_REFERENCE:-}" != 1 ]; then
  echo "[terrain] refused: policy version(s) $REFS use this dataset; publish a policy naming another dataset first," \
       "or set ALLOW_POLICY_REFERENCE=1 to remove and reload the same product" >&2
  exit 4
fi
if [ "${CONFIRM_TARGET:-}" != "$TARGET" ]; then
  echo "[terrain] dry run: set CONFIRM_TARGET=$TARGET to remove"
  exit 3
fi

# one snapshot for both counts: the application may keep writing meanwhile, and only this removal's own effect is checked
psql_t --single-transaction <<SQL
set transaction isolation level repeatable read;
create temp table business_before on commit drop as
  select 'stationing_policy_version' t, count(*) n from stationing_policy_version union all
  select 'org_stationing', count(*) from org_stationing union all
  select 'site_link', count(*) from site_link union all
  select 'stationing_outbox', count(*) from stationing_outbox union all
  select 'audit_event', count(*) from audit_event;
delete from terrain_slope where dataset_id in (select id from terrain_dataset where code = '$CODE' and version = '$VERSION');
delete from terrain_dataset where code = '$CODE' and version = '$VERSION';
do \$check\$
declare changed text;
begin
  select string_agg(b.t, ', ') into changed from business_before b
    join (select 'stationing_policy_version' t, count(*) n from stationing_policy_version union all
          select 'org_stationing', count(*) from org_stationing union all
          select 'site_link', count(*) from site_link union all
          select 'stationing_outbox', count(*) from stationing_outbox union all
          select 'audit_event', count(*) from audit_event) a on a.t = b.t
   where a.n <> b.n;
  if changed is not null then raise exception 'terrain removal changed business tables: %', changed; end if;
end \$check\$;
SQL
echo "[terrain] removed $CODE $VERSION; business tables unchanged. The space returns after autovacuum (or VACUUM terrain_slope)."
