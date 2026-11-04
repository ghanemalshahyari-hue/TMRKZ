#!/usr/bin/env sh
# Loads the terrain slope ANALYSIS product (ops/terrain/build_terrain.py) into PostGIS: one terrain_dataset row and the
# 256x256 slope tiles in terrain_slope (schema: migration V18). Uses raster2pgsql from the local postgis image; offline.
#
#   sh ops/terrain/load-slope.sh <container|compose-project> <dataset-version>          # PLAN only (dry run), exit 3
#   CONFIRM_TARGET=<same target> sh ops/terrain/load-slope.sh <target> <dataset-version>  # load
#
# The target is a running PostgreSQL container name, or a compose project whose service `db` is running. There is no
# default target, and the owner-retained production project is refused. The load is a separate operation after the
# migration and never part of it (owner, 4 Nov 2026). Restartable: it is one transaction, so an interrupted load leaves
# nothing and is simply run again. Idempotent per (code, version): the same product again re-checks the loaded rows and
# cells and changes nothing; a different product under an existing (code, version) is refused. Before committing it
# checks the row count, all cells and the cells with a value against the plan (manifest build counts), and the SRID,
# pixel type and nodata of every tile; the manifest (source tiles and checksums, processing version, derived checksums,
# licence notices) is stored with the dataset. ops/terrain/unload-slope.sh removes a dataset again without touching any
# Stationing business record. Env: TERRAIN_CODE (copernicus-glo30), TERRAIN_DIR, TERRAIN_MANIFEST, PGDATABASE, PGUSER.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
TARGET="${1:-}"
VERSION="${2:-}"
if [ -z "$TARGET" ] || [ -z "$VERSION" ]; then
  echo "usage: [CONFIRM_TARGET=<target>] sh ops/terrain/load-slope.sh <container|compose-project> <dataset-version>" >&2
  exit 2
fi
CODE="${TERRAIN_CODE:-copernicus-glo30}"
DIR="${TERRAIN_DIR:-map-data/terrain/glo30/analysis}"
MANIFEST="${TERRAIN_MANIFEST:-map-packages/terrain-glo30-2026.11/manifest.json}"
DB="${PGDATABASE:-mover}"
DBUSER="${PGUSER:-mover}"
IMAGE=postgis/postgis:17-3.5-alpine
TILE=256
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

PLAN="$(python ops/terrain/slope_plan.py "$DIR" "$MANIFEST" "$TILE")" || { eval "$PLAN"; exit 1; }
eval "$PLAN"
SCHEMA="$(psql_t -At -c "select coalesce((select version from flyway_schema_history where success order by installed_rank desc limit 1), 'none')" 2>/dev/null || echo unknown)"
HAS="$(psql_t -At -c "select (to_regclass('terrain_dataset') is not null and to_regclass('terrain_slope') is not null)::text")"
EXISTING="$(psql_t -At -c "select slope_sha256 from terrain_dataset where code = '$CODE' and version = '$VERSION'" 2>/dev/null || true)"

echo "[terrain] plan"
echo "  target          : $TARGET ($KIND), database $DB, schema version $SCHEMA"
echo "  dataset         : $CODE $VERSION (surface model DSM, $([ -f "$MANIFEST" ] && echo "manifest $MANIFEST" || echo 'no manifest'))"
echo "  product         : $FILES files, $BYTES bytes, SHA256SUMS sha256 $SLOPE_SHA256"
echo "  rows to insert  : $TILES tiles of ${TILE}x${TILE} (empty tiles kept)"
echo "  cells           : $CELLS, of which $VALID with a value"
echo "  schema present  : $HAS"
echo "  already loaded  : ${EXISTING:-no}"
[ "$HAS" = "true" ] || { echo "[terrain] terrain_dataset / terrain_slope missing (migration V18 not applied); nothing done" >&2; exit 2; }
# the checks a load must pass, also run against an existing load of the same product
check_sql() {
  cat <<SQL
do \$check\$
declare n bigint; cells numeric; valid numeric; bad bigint;
begin
  select count(*), coalesce(sum(ST_Width(t.rast)::numeric * ST_Height(t.rast)), 0),
         coalesce(sum(ST_Count(t.rast, 1, true)), 0)
    into n, cells, valid
    from terrain_slope t join terrain_dataset d on d.id = t.dataset_id where d.code = '$CODE' and d.version = '$VERSION';
  if n <> $TILES then raise exception 'terrain load: % rows, expected $TILES', n; end if;
  if cells <> $CELLS then raise exception 'terrain load: % cells, expected $CELLS', cells; end if;
  if valid <> $VALID then raise exception 'terrain load: % cells with a value, expected $VALID', valid; end if;
  select count(*) into bad from terrain_slope t join terrain_dataset d on d.id = t.dataset_id
   where d.code = '$CODE' and d.version = '$VERSION'
     and (ST_SRID(t.rast) <> 4326 or ST_NumBands(t.rast) <> 1 or ST_BandPixelType(t.rast, 1) <> '16BUI'
          or ST_BandNoDataValue(t.rast, 1) is distinct from 65535);
  if bad > 0 then raise exception 'terrain load: % tiles with unexpected SRID, band type or nodata', bad; end if;
  raise notice 'terrain check: % rows, % cells, % with a value', n, cells, valid;
end \$check\$;
SQL
}
if [ -n "$EXISTING" ]; then
  if [ "$EXISTING" = "$SLOPE_SHA256" ]; then
    check_sql | psql_t || { echo "[terrain] $CODE $VERSION is loaded but fails the checks; remove it (unload-slope.sh) and load again" >&2; exit 5; }
    echo "[terrain] same product already loaded and checked; nothing to do"; exit 0
  fi
  echo "[terrain] $CODE $VERSION exists with a different product ($EXISTING); refusing (use a new version)" >&2
  exit 4
fi
if [ "${CONFIRM_TARGET:-}" != "$TARGET" ]; then
  echo "[terrain] dry run: set CONFIRM_TARGET=$TARGET to load"
  exit 3
fi

HOST_DIR="$(cd "$DIR" && (pwd -W 2>/dev/null || pwd))"
START="$(date +%s)"
{
  cat <<SQL
create temp table terrain_slope_stage (seq bigserial, rast raster, filename text) on commit drop;
SQL
  docker run --rm -v "$HOST_DIR:/data:ro" "$IMAGE" sh -c \
    "raster2pgsql -a -e -k -Y 1000 -F -s 4326 -t ${TILE}x${TILE} -N 65535 /data/slope_pct_x100_*.tif terrain_slope_stage"
  cat <<SQL
insert into terrain_dataset (id, code, version, surface_model, slope_encoding, manifest, slope_sha256)
values (gen_random_uuid(), '$CODE', '$VERSION', 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16',
        \$manifest\$$( [ -f "$MANIFEST" ] && cat "$MANIFEST" || echo '{}' )\$manifest\$::jsonb, '$SLOPE_SHA256');
insert into terrain_slope (dataset_id, rast)
select d.id, s.rast from terrain_slope_stage s join terrain_dataset d on d.code = '$CODE' and d.version = '$VERSION'
 order by s.filename, s.seq;
SQL
  check_sql
} | psql_t --single-transaction || {
  echo "[terrain] load failed and was rolled back; nothing was kept. Fix the cause and run it again" >&2
  exit 1
}
END="$(date +%s)"
psql_t -At -F ' | ' -c "select d.code, d.version, d.slope_sha256, count(t.rid) as tiles,
  pg_size_pretty(pg_total_relation_size('terrain_slope')) as table_size
  from terrain_dataset d left join terrain_slope t on t.dataset_id = d.id
 where d.code = '$CODE' and d.version = '$VERSION' group by d.code, d.version, d.slope_sha256"
echo "[terrain] loaded in $((END - START)) s"
