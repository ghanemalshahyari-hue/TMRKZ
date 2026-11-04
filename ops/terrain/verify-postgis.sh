#!/usr/bin/env sh
# PostGIS checks of the terrain contract on a DISPOSABLE PostGIS container that has terrain_dataset/terrain_slope:
#   1. the backend fixture (hex WKB) loads with plain SQL and ST_Clip's default inclusion is the pixel centre
#      (expected counts from backend/src/test/resources/terrain/slope-fixture.json), touched=true gives all-touched;
#   2. the loader refuses a different product under an existing (code, version) (exit 4);
#   3. class shares + timing for a fictional polygon on the full dataset, when it is loaded.
# Usage: sh ops/terrain/verify-postgis.sh <disposable-container>
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
C="${1:?disposable postgis container}"
q() { docker exec -i "$C" psql -X -q -At -v ON_ERROR_STOP=1 -U mover -d mover "$@"; }
FIX=backend/src/test/resources/terrain

echo "[verify] 1. fixture and ST_Clip inclusion"
{
  echo "insert into terrain_dataset (id, code, version, surface_model, slope_encoding, manifest, slope_sha256)"
  echo "values ('00000000-0000-0000-0000-00000000f1c5', 'fixture', 'test', 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16', '{}', 'fixture');"
  while IFS= read -r hex; do
    [ -n "$hex" ] && echo "insert into terrain_slope (dataset_id, rast) values ('00000000-0000-0000-0000-00000000f1c5', '$hex'::raster);"
  done <<EOF_HEX
$(tr -d '' < "$FIX/slope-fixture.hexwkb")
EOF_HEX
} | q --single-transaction
POLY="$(python -c "import json;print(json.dumps(json.load(open('$FIX/slope-fixture.json'))['testPolygon']))")"
for touched in false true; do
  q -F ' ' <<SQL
with g as (select ST_SetSRID(ST_GeomFromGeoJSON('$POLY'), 4326) g),
vc as (select (ST_ValueCount(ST_Clip(t.rast, g.g, true, $touched))).* from terrain_slope t, g
        where t.dataset_id = '00000000-0000-0000-0000-00000000f1c5' and ST_Intersects(t.rast, g.g))
select 'touched=$touched',
       sum(count) filter (where value < 200), sum(count) filter (where value >= 200 and value < 1000),
       sum(count) filter (where value >= 1000 and value < 1500), sum(count) filter (where value >= 1500 and value < 3000),
       sum(count) filter (where value >= 3000), sum(count) from vc;
SQL
done
python -c "import json;m=json.load(open('$FIX/slope-fixture.json'));print('expected centre ', *m['expectedCellsPixelCentre'].values(), m['expectedCellsTotalPixelCentre']);print('expected touched', *m['expectedCellsAllTouched'].values(), m['expectedCellsTotalAllTouched'])"
q -c "delete from terrain_slope where dataset_id = '00000000-0000-0000-0000-00000000f1c5'; delete from terrain_dataset where code = 'fixture';"

echo "[verify] 2. different product under an existing version"
q -c "insert into terrain_dataset (id, code, version, surface_model, slope_encoding, manifest, slope_sha256) values (gen_random_uuid(), 'copernicus-glo30', 'refusal-test', 'DSM', 'SLOPE_PERCENT_X100_FLOOR_U16', '{}', 'not-this-product')"
set +e
CONFIRM_TARGET="$C" sh ops/terrain/load-slope.sh "$C" refusal-test >/dev/null 2>&1
rc=$?
set -e
q -c "delete from terrain_dataset where version = 'refusal-test'"
echo "loader exit $rc (expected 4)"

echo "[verify] 3. class shares on the full dataset (fictional polygon, Hajar foothills)"
q -F ' | ' <<'SQL'
\timing on
with g as (select ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[55.760,24.050],[55.775,24.050],[55.775,24.064],[55.760,24.064],[55.760,24.050]]]}'), 4326) g),
vc as (select (ST_ValueCount(ST_Clip(t.rast, g.g))).* from terrain_slope t join terrain_dataset d on d.id = t.dataset_id, g
        where d.code = 'copernicus-glo30' and d.version = '2026.11' and ST_Intersects(t.rast, g.g)),
cls as (select case when value < 200 then '1 FLAT [0,2)' when value < 1000 then '2 UNDULATING [2,10)'
                    when value < 1500 then '3 ROLLING [10,15)' when value < 3000 then '4 HILLY [15,30)'
                    else '5 MOUNTAINOUS [30,inf)' end c, count from vc)
select c, sum(count), round(100.0 * sum(count) / sum(sum(count)) over (), 2) from cls group by c order by c;
SQL
