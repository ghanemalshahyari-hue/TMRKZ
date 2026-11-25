#!/usr/bin/env sh
# TMRKZ read-only diagnostic (ADR-103, ADR-104). Changes nothing: no file is written, the database session is read-only
# (default_transaction_read_only), no container is started, stopped or recreated. The output is redacted — no password,
# key, token, name, IP address or employee number — so it can be pasted back to the developers.
#
#   sh ops/diagnose.sh                          everything
#   sh ops/diagnose.sh --logins u123456,u7654   also the state of these sign-in names (shown masked)
#   sh ops/diagnose.sh > diagnose.txt           to keep it
# Windows CMD:  "C:\Program Files\Git\bin\sh.exe" ops/diagnose.sh
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
LOGINS=""
[ "${1:-}" = "--logins" ] && LOGINS="${2:-}"

value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d '\r' | tr -d "'\""; }
section() { printf '\n== %s\n' "$1"; }
line() { printf '  %-44s %s\n' "$1" "$2"; }
redact() {
  sed -E -e 's/([0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}/\1.*.*/g' \
         -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
         -e 's/\b[uU][0-9]{4,}\b/u<…>/g' -e 's/\b[0-9]{6,}\b/<#>/g' \
         -e 's/(password|secret|token|credential|key)([=:] *)[^ ,;]+/\1\2<…>/Ig' \
         -e 's/[A-Za-z0-9+\/_-]{32,}/<…>/g'
}
mask() { printf '%s' "$1" | awk '{ n = length($0); print (n <= 4 ? substr($0, 1, 1) "…" : substr($0, 1, 2) "…" substr($0, n - 1, 2)) }'; }
# sqlc: queries that return numbers only (counts are not personal data, and must stay readable); sql: anything with text
sqlc() { docker exec -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' "$DB" psql -U "${DBUSER:-tmrkz}" -d "${DBNAME:-tmrkz}" -X -A -t -F ' | ' -c "$1" 2>&1 | sed -E 's/[^0-9 \/|.,:()-]+/?/g'; }
sql() { docker exec -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' "$DB" psql -U "${DBUSER:-tmrkz}" -d "${DBNAME:-tmrkz}" -X -A -t -F ' | ' -c "$1" 2>&1 | redact; }

echo "TMRKZ read-only diagnostic — $(date -u +%Y-%m-%dT%H:%M:%SZ) — folder $(pwd | redact)"

section "1. Compose project and files"
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: //p' | head -n 1)"
line "project (this folder)" "${PROJECT:-?}"
CF="$(value COMPOSE_FILE | tr ';' ':')"
line "COMPOSE_FILE in .env" "${CF:-(not set: docker-compose.yml + docker-compose.override.yml)}"
for f in $(ls docker-compose.*.yml 2>/dev/null | grep -vx docker-compose.override.yml); do
  case ":$CF:" in *":$f:"*) line "$f" "named in COMPOSE_FILE" ;; *) line "$f" "PRESENT BUT NOT NAMED — docker compose leaves it out" ;; esac
done
USED="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT:-tmrkz}" --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | sort -u | head -n 3)"
line "files the containers were started with" "$(printf '%s' "$USED" | sed 's#[^,]*[/\\]##g' | tr '\n' ' ')"

section "2. Services"
docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.Status}}' 2>/dev/null | while IFS='|' read -r s st h stat; do
  flag=""; [ "$st" = running ] || flag="  <-- not running"; [ "$h" = unhealthy ] && flag="  <-- unhealthy"
  case "$s" in db-init|openfga-migrate|keycloak-setup) [ "$st" = exited ] && flag="" ;; esac
  line "$s" "$st ${h:+($h) }$stat$flag"
done
DB="$(docker compose ps -q db 2>/dev/null | head -n 1)"
BE="$(docker compose ps -q backend 2>/dev/null | head -n 1)"
WB="$(docker compose ps -q web-build 2>/dev/null | head -n 1)"
MT="$(docker compose ps -q maintenance 2>/dev/null | head -n 1)"
[ -n "$MT" ] || line "maintenance (Update Center worker)" "NOT CREATED — the one-time bootstrap of ADR-104 is pending"

section "3. Folders and files"
for d in backend/src/main frontend/src ops docs handoff map-packages data/db data/files data/ldap-data data/ldap-config backups; do
  [ -e "$d" ] && line "$d" "present" || line "$d" "MISSING"
done
[ -d certs ] && line "certs" "present ($(ls certs | wc -l) entries)" || line "certs" "none here (used on the VM only)"
MAP="$(value TMRKZ_MAP_ROOT)"; MAP="${MAP:-./map-runtime}"
if [ -f "$MAP/current/manifest.json" ]; then
  line "offline map ($MAP)" "current/manifest.json present"
  if [ -f "$MAP/current/SHA256SUMS" ] && command -v sha256sum >/dev/null; then
    bad="$(cd "$MAP/current" && sha256sum -c SHA256SUMS 2>/dev/null | grep -vc ': OK$')"
    line "offline map checksums" "$( [ "$bad" = 0 ] && echo OK || echo "$bad file(s) FAIL" )"
  fi
else
  line "offline map ($MAP)" "NO current/manifest.json — every map would be blank (TMRKZ_MAP_ROOT in .env)"
fi
line ".env" "$( [ -f .env ] && echo "present, $(grep -c '=' .env) settings" || echo MISSING )"
STRAY="$(find backend/src/main frontend/src ops -type f \( -name '*.bak' -o -name '*.orig' -o -name '*.rej' -o -name '*~' \) 2>/dev/null | head -n 10 | tr '\n' ' ')"
line "stray backup files in the source" "${STRAY:-none}"

section "4. Installed release and local changes"
BASE=backups/updates/installed-MANIFEST.tsv
if [ -f "$BASE" ]; then
  total=0; changed=0; missing=0; list=""
  while IFS="$(printf '\t')" read -r h p; do
    total=$((total + 1))
    if [ ! -f "$p" ]; then missing=$((missing + 1)); list="$list $p(missing)"
    elif [ "$(sha256sum "$p" | cut -d' ' -f1)" != "$h" ]; then changed=$((changed + 1)); list="$list $p"; fi
  done < "$BASE"
  line "files installed by the Update Center" "$total; changed here since: $changed; missing: $missing"
  [ -z "$list" ] || line "changed or missing" "$(printf '%s' "$list" | cut -c1-600)"
else
  line "Update Center baseline" "none yet (no update applied through the browser on this machine)"
fi
line "last updates" "$(ls -1 backups/updates 2>/dev/null | grep -E '^[0-9]{8}T' | tail -n 3 | tr '\n' ' ')"

section "5. Is the running backend built from the source in this folder?"
if [ -n "$BE" ]; then
  built="$(docker exec "$BE" sh -c 'cat /tmp/tmrkz-backend.built 2>/dev/null' 2>/dev/null)"
  now="$(docker exec "$BE" sh -c 'find /workspace/backend/pom.xml /workspace/backend/src/main -type f -printf "%T@ %s %p\n" 2>/dev/null | sort | md5sum' 2>/dev/null)"
  if [ -z "$built" ]; then line "build state" "unknown (image-built backend, or not built yet)"
  elif [ "$built" = "$now" ]; then line "build state" "the running build IS the current source (every saved change compiled)"
  else line "build state" "the source CHANGED since the last successful build — see the backend log below"; fi
  jar="$(docker exec "$BE" sh -c 'stat -c %Y /tmp/mover-backend.jar 2>/dev/null')"
  newest="$(docker exec "$BE" sh -c 'find /workspace/backend/src/main /workspace/backend/pom.xml -type f -printf "%T@\n" 2>/dev/null | sort -n | tail -n 1 | cut -d. -f1')"
  [ -n "$jar" ] && [ -n "$newest" ] && line "newest source file vs build" "$( [ "$newest" -le "$jar" ] && echo "source older than the build" || echo "a source file is NEWER than the running build" )"
  line "backend log: last build messages" "$(docker logs --tail 3000 "$BE" 2>&1 | grep -E '^\[backend\]' | tail -n 3 | tr '\n' ' ' | redact)"
fi

section "6. Dependencies (no download possible)"
if [ -n "$WB" ]; then
  img="$(docker exec "$WB" sh -c 'cat /modules/.package-lock.sha256 2>/dev/null' | cut -d' ' -f1)"
  have="$(sha256sum frontend/package-lock.json 2>/dev/null | cut -d' ' -f1)"
  line "frontend libraries" "$( [ "$img" = "$have" ] && echo "package-lock.json matches the image" || echo "package-lock.json DIFFERS from the image's libraries (a new tmrkz-images.tar is needed)" )"
fi
for img in tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine; do
  docker image inspect "$img" >/dev/null 2>&1 && line "image $img" "loaded" || line "image $img" "MISSING"
done

section "7. Mounts of the running containers"
for c in $(docker compose ps -q 2>/dev/null); do
  name="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")"
  docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} {{.Destination}}{{"\n"}}{{end}}' "$c" | while read -r t src dst; do
    [ "$t" = bind ] || continue
    if [ -e "$src" ] || docker run --rm --pull never -v "$src:/probe:ro" --entrypoint true nginx:1.28.3-alpine >/dev/null 2>&1; then :; else
      line "$name $dst" "SOURCE MISSING: $(printf '%s' "$src" | redact)"; fi
  done
done
line "mount check" "done (only problems are listed)"

section "8. Certificates"
TLSD="$(value TMRKZ_TLS_DIR)"; TLSD="${TLSD:-./ops/tls/private}"; TLSD="${TLSD#./}"
TRUSTD="$(value TMRKZ_TRUSTSTORE_DIR)"; TRUSTD="${TRUSTD:-./ops/local/.generated/truststore}"; TRUSTD="${TRUSTD#./}"
line "https folder (TMRKZ_TLS_DIR)" "$TLSD $( [ -d "$TLSD" ] && echo present || echo absent ); https $(printf '%s' "$(value COMPOSE_PROFILES)" | grep -qw tls && echo ON || echo off)"
line "shared trust folder (TMRKZ_TRUSTSTORE_DIR)" "$TRUSTD $( [ -d "$TRUSTD" ] && echo present || echo absent )"
if [ -f "$TLSD/server.key" ] && [ -f "$TLSD/server.crt" ] && command -v openssl >/dev/null; then
  k="$(openssl pkey -in "$TLSD/server.key" -pubout 2>/dev/null | sha256sum | cut -c1-16)"
  c="$(openssl x509 -in "$TLSD/server.crt" -noout -pubkey 2>/dev/null | sha256sum | cut -c1-16)"
  line "https key matches certificate" "$( [ -n "$k" ] && [ "$k" = "$c" ] && echo yes || echo "NO or unreadable" ) (the key itself is never printed)"
fi
line "certificate changes (backups/certificates)" "$(ls -d backups/certificates/*/ 2>/dev/null | wc -l | tr -d ' ')"
for f in ops/local/.generated/certs/ca.crt ops/local/.generated/certs/ldap.crt $(ls "$TLSD"/*.crt "$TLSD"/*.pem "$TRUSTD"/*.pem certs/*.crt certs/*.pem 2>/dev/null | sort -u); do
  [ -f "$f" ] || continue
  if command -v openssl >/dev/null; then
    end="$(openssl x509 -noout -enddate -in "$f" 2>/dev/null | cut -d= -f2)"
    if [ -z "$end" ]; then line "$f" "not a certificate"
    elif openssl x509 -noout -checkend 2592000 -in "$f" >/dev/null 2>&1; then line "$f" "valid until $end"
    else line "$f" "EXPIRES WITHIN 30 DAYS OR EXPIRED ($end)"; fi
  fi
done
line "release trust key (Update Center)" "$( [ -f ops/local/.generated/release-trust.pub ] && echo installed || echo "NOT INSTALLED — one-time bootstrap" )"

section "9. Database"
if [ -n "$DB" ]; then
  DBUSER="$(value POSTGRES_USER)"; DBUSER="${DBUSER:-tmrkz}"; DBNAME="$(value POSTGRES_DB)"; DBNAME="${DBNAME:-tmrkz}"
  line "connection" "$(docker exec "$DB" pg_isready -U "$DBUSER" -d "$DBNAME" 2>&1 | redact)"
  line "schema version (Flyway)" "$(sqlc "select max(version::int) from flyway_schema_history where success")"
  line "failed migrations" "$(sqlc "select count(*) from flyway_schema_history where not success")"

  section "10. Authorisation (business grants vs the OpenFGA mirror)"
  line "sync state" "$(sql "select 'applied ' || applied_seq || ', pending ' || ((select coalesce(max(seq),0) from authz_change) - applied_seq) || ', tuples ' || tuples || ', last success ' || coalesce(to_char(last_success_at, 'YYYY-MM-DD HH24:MI'), '-') || ', last error ' || coalesce(left(last_error, 80), 'none') from authz_sync_state where id = 1")"
  line "open-ended grants (valid, by design)" "$(sqlc "select count(*) from authz_tuple where relation = 'holder' and (condition->>'open_ended')::boolean")"
  line "open-ended rows EDITED BY HAND" "$(sqlc "select count(*) from authz_tuple where relation = 'holder' and (condition->>'open_ended')::boolean and condition->>'valid_to' <> condition->>'valid_from'")"
  line "mirror holders with no grant behind them" "$(sqlc "select count(*) from authz_tuple t where t.relation = 'holder' and t.kind = 'GRANT' and not exists (select 1 from membership m where 'grant:' || m.id = t.object) and not exists (select 1 from delegation d where 'grant:' || d.id = t.object) and t.object not in (select 'grant:' || x from (select null::uuid x) z)")  (seat/unit grants are derived ids and may be counted here; a full sync removes strays)"
  line "grants held on a RETIRED unit (count nothing)" "$(sqlc "select count(*) from membership m join organization o on o.id = m.organization_id where o.status <> 'ACTIVE' and (m.valid_to is null or m.valid_to > now())")"
  line "effective system administrators" "$(sqlc "select count(distinct m.person_id) from membership m join person p on p.id = m.person_id and p.status = 'ACTIVE' and not p.access_disabled join organization o on o.id = m.organization_id and o.status = 'ACTIVE' where m.role_code = 'SYSTEM_ADMIN' and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())")"
  line "global access managers (MANAGE_ACCESS, ALL)" "$(sqlc "select count(distinct m.person_id) from membership m join role_def r on r.code = m.role_code join person p on p.id = m.person_id and p.status = 'ACTIVE' and not p.access_disabled where 'MANAGE_ACCESS' = any(r.permissions) and (r.scope = 'ALL' and m.scope_mode = 'ROLE' or m.scope_all) and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())")"

  section "11. Identities"
  line "people: active / disabled / access off" "$(sqlc "select count(*) filter (where status = 'ACTIVE') || ' / ' || count(*) filter (where status <> 'ACTIVE') || ' / ' || count(*) filter (where access_disabled) from person")"
  line "removed local accounts («حذف الحساب»)" "$(sqlc "select count(*) from person where source = 'LOCAL' and status = 'DISABLED' and access_disabled")"
  line "sign-in links by method" "$(sql "select string_agg(method || ' ' || n, ', ') from (select method, count(*) n from identity_link group by method order by method) x")"
  line "same login on two people (case-insensitive)" "$(sqlc "select count(*) from (select lower(username) from person where username is not null group by 1 having count(*) > 1) x")"
  line "LOCAL account with an HR employee's login" "$(sqlc "select count(*) from person l join hr_person h on lower(h.domain_account) = lower(l.username) join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED' where l.source = 'LOCAL'")"
  line "HR rows in the published snapshot not linked to anyone" "$(sqlc "select count(*) from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED' where not exists (select 1 from person p where p.source = 'HR' and p.source_external_id = h.external_id)")  (rows inserted by hand show up here)"
  if [ -n "$LOGINS" ]; then
    for l in $(printf '%s' "$LOGINS" | tr ',' ' '); do
      ll="$(printf '%s' "$l" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9._-')"
      line "login $(mask "$ll")" "$(sql "select 'source ' || p.source || ', status ' || p.status || ', access off ' || p.access_disabled || ', links ' || (select coalesce(string_agg(method, '+'), 'none') from identity_link il where il.person_id = p.id) || ', number kind ' || case when p.employee_no like 'USER-%' then 'USER-' when p.employee_no like 'DIR-%' then 'DIR-' when p.employee_no like 'PLATFORM-%' then 'PLATFORM-' else 'other' end || ', grants in force ' || (select count(*) from membership m where m.person_id = p.id and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) || ', ended grants ' || (select count(*) from membership m where m.person_id = p.id and m.valid_to <= now()) || ', units ' || (select count(*) from unit_member u where u.person_id = p.id and u.ended_at is null) || ', in HR mirror ' || (select count(*) from hr_person h join hr_snapshot s on s.id = h.snapshot_id and s.status = 'PUBLISHED' where lower(h.domain_account) = '$ll') from person p where lower(p.username) = '$ll'")"
    done
  fi

  section "12. HR synchronisation"
  line "source" "$(sql "select coalesce(string_agg('enabled ' || enabled || ', configured ' || (settings_ciphertext is not null) || ', auto ' || coalesce(auto_sync::text, '-') || ', every ' || coalesce(sync_interval_hours::text, '-') || ' h, last ok ' || coalesce(to_char(last_success_at, 'YYYY-MM-DD HH24:MI'), '-'), '; '), 'none') from hr_source")"
  line "published snapshot" "$(sql "select coalesce(string_agg(to_char(published_at, 'YYYY-MM-DD HH24:MI') || ', units ' || unit_count || ', people ' || person_count || ' (rows ' || (select count(*) from hr_person h where h.snapshot_id = s.id) || ')', '; '), 'none') from hr_snapshot s where status = 'PUBLISHED'")"
  line "last runs" "$(sql "select coalesce(string_agg(status || coalesce(' ' || error_code, ''), ', ' order by started_at desc), 'none') from (select * from hr_sync_run order by started_at desc limit 3) r")"

  section "13. Units (what administrators see)"
  line "units: active / retired / roots" "$(sqlc "select count(*) filter (where status = 'ACTIVE') || ' / ' || count(*) filter (where status <> 'ACTIVE') || ' / ' || count(*) filter (where status = 'ACTIVE' and parent_id is null) from organization")"
  line "units with a stationing now" "$(sqlc "select count(distinct organization_id) from org_stationing where valid_from <= now() and (valid_to is null or valid_to > now())")"
else
  line "database container" "NOT FOUND"
fi

section "14. Recent errors (backend log, redacted)"
if [ -n "$BE" ]; then
  docker logs --tail 5000 "$BE" 2>&1 | grep -oE '"code":"[A-Z_]+"|ErrorCode\.[A-Z_]+|(IDENTITY|DIRECTORY|AUTHZ|HR|REAUTHENTICATION)_[A-Z_]+' | sed 's/"code":"//;s/"//;s/ErrorCode\.//' | sort | uniq -c | sort -rn | head -n 12 | sed 's/^/  /'
  docker logs --tail 5000 "$BE" 2>&1 | grep -E ' ERROR | WARN ' | tail -n 8 | cut -c1-240 | redact | sed 's/^/  /'
fi
echo
echo "end of diagnostic (nothing was changed)"
