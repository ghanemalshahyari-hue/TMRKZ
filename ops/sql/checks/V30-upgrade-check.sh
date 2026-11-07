#!/usr/bin/env sh
# Proves V30 on a throwaway PostgreSQL (never a retained database): clean path V1…V30, and upgrade path V1…V29 + legacy rows + V30.
# The legacy rows: one request that stationed two units with one pair of areas, one superseded stationing whose areas were left
# active by earlier versions. Afterwards every row is still there, each unit has its own pair, and the stale pair is retired.
set -eu
cd "$(dirname "$0")/../../.."
NAME="tmrkz-v30-check-$$"
M=backend/src/main/resources/db/migration
docker run -d --name "$NAME" -e POSTGRES_DB=mover -e POSTGRES_USER=mover -e POSTGRES_PASSWORD=check postgis/postgis:17-3.5-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
until docker exec "$NAME" pg_isready -U mover -d mover >/dev/null 2>&1; do sleep 1; done
sleep 3
run() { docker exec -i "$NAME" psql -X -q -1 -v ON_ERROR_STOP=1 -U mover -d "$1"; }
file_of() { ls "$M" | grep -E "^V$1__"; }
versions() { ls "$M" | sed -E 's/^V([0-9]+)__.*/\1/' | sort -n; }
apply_to() { for v in $(versions); do [ "$v" -le "$2" ] || continue; run "$1" < "$M/$(file_of "$v")"; done; }
docker exec "$NAME" createdb -U mover clean
docker exec "$NAME" psql -q -U mover -d clean -c 'create extension if not exists postgis' 2>/dev/null || true
apply_to clean 30
echo "clean path: V1…V30 applied"
docker exec "$NAME" createdb -U mover upgrade
docker exec "$NAME" psql -q -U mover -d upgrade -c 'create extension if not exists postgis' 2>/dev/null || true
apply_to upgrade 29
run upgrade <<'SQL'
insert into person(id, employee_no, display_name, username) values ('00000000-0000-0000-0000-000000000001', 'E1', 'وهمي', 'u1');
insert into organization(id, code, name, valid_from) values
  ('00000000-0000-0000-0000-00000000000a', 'A', 'أ', now()), ('00000000-0000-0000-0000-00000000000b', 'B', 'ب', now());
insert into site(id, code, name, kind, lat, lng) values ('00000000-0000-0000-0000-0000000000f1', 'S1', 'موقع', 'موقع', 25, 55), ('00000000-0000-0000-0000-0000000000f2', 'S2', 'قديم', 'موقع', 25.1, 55);
insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, content, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000011', 'R1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'DRAFT', 'PERMANENT', now(), '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000012', 'R2', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'DRAFT', 'PERMANENT', now(), '{}', now(), now());
insert into org_stationing(id, organization_id, site_id, kind, valid_from, valid_to, end_reason, origin, request_id, reason, recorded_by) values
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f2', 'PERMANENT', now() - interval '20 days', now() - interval '10 days', 'SUPERSEDED', 'REQUEST', '00000000-0000-0000-0000-000000000012', 'سجل قديم', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'PERMANENT', now() - interval '10 days', null, null, 'REQUEST', '00000000-0000-0000-0000-000000000011', 'سجل حالي', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000f1', 'PERMANENT', now() - interval '10 days', null, null, 'REQUEST', '00000000-0000-0000-0000-000000000011', 'سجل حالي', '00000000-0000-0000-0000-000000000001');
insert into deployment_area(id, request_id, site_id, role, geom, state, valid_from)
select gen_random_uuid(), v.r, v.s, v.role, ST_MakeEnvelope(55, 25, 55.01, 25.01, 4326), 'ACTIVE', now() - interval '10 days' from (values
  ('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-0000000000f1'::uuid, 'PRIMARY'),
  ('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-0000000000f1'::uuid, 'ALTERNATIVE'),
  ('00000000-0000-0000-0000-000000000012'::uuid, '00000000-0000-0000-0000-0000000000f2'::uuid, 'PRIMARY')) v(r, s, role);
SQL
BEFORE="$(docker exec "$NAME" psql -X -At -U mover -d upgrade -c 'select (select count(*) from restationing_request) || chr(47) || (select count(*) from org_stationing)')"
run upgrade < "$M/$(file_of 30)"
RESULT="$(docker exec -i "$NAME" psql -X -At -U mover -d upgrade <<'SQL'
select 'A areas active on its current record: ' || count(*) from deployment_area where organization_id = '00000000-0000-0000-0000-00000000000a' and state = 'ACTIVE' and stationing_id = '00000000-0000-0000-0000-000000000021';
select 'B areas active on its current record: ' || count(*) from deployment_area where organization_id = '00000000-0000-0000-0000-00000000000b' and state = 'ACTIVE' and stationing_id = '00000000-0000-0000-0000-000000000023';
select 'stale area retired with its stationing: ' || count(*) from deployment_area where request_id = '00000000-0000-0000-0000-000000000012' and state = 'RETIRED';
select 'every existing request is re-stationing: ' || count(*) from restationing_request where purpose = 'RESTATIONING';
SQL
)"
echo "$RESULT"
EXPECTED="A areas active on its current record: 2
B areas active on its current record: 2
stale area retired with its stationing: 1
every existing request is re-stationing: 2"
[ "$RESULT" = "$EXPECTED" ] || { echo "UNEXPECTED RESULT"; exit 1; }
AFTER="$(docker exec "$NAME" psql -X -At -U mover -d upgrade -c 'select (select count(*) from restationing_request) || chr(47) || (select count(*) from org_stationing)')"
[ "$BEFORE" = "$AFTER" ] && echo "rows kept: requests/stationing $AFTER" || { echo "ROWS CHANGED: $BEFORE -> $AFTER"; exit 1; }
echo "upgrade path: passed"
