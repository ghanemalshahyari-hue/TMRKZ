#!/usr/bin/env sh
# Clean migration-path verification on a DISPOSABLE environment — never an owner-retained database.
#
# Starts a fresh fictional test environment on the release image FROM (before the migration), creates business records
# through the real application (tests/acceptance/journey.mjs), then upgrades it to image TO with the documented sequence
# (docs/OPERATIONS.md "Upgrade and rollback"): schema before → migration plan → backup (ops/backup.sh, manifest with
# SHA-256) → restore proof (ops/verify-restore.sh, optional) → ops/upgrade-check.sh before → start TO, Flyway applies the
# pending migrations on start → flyway_schema_history → schema after → ops/upgrade-check.sh after → compatibility journey
# on TO. The plan must list exactly EXPECT_PENDING, otherwise nothing is applied. The project is removed afterwards
# unless KEEP=1. Database dumps stay in backups/ (git-ignored); the evidence directory holds no secrets.
#
# Usage: EXPECT_PENDING="17" sh ops/verify-migration-path.sh <from-image> <to-image> <label>
#        VERIFY_RESTORE=0 skips the restore proof (a second full stack); P=<project> and PORT=<port> override
#        tmrkz-migpath / 8099.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
FROM="${1:?from-image}"
TO="${2:?to-image}"
LABEL="${3:?label}"
EXPECT_PENDING="${EXPECT_PENDING:?space-separated versions the plan must contain, e.g. 17}"
P="${P:-tmrkz-migpath}"
PORT="${PORT:-8099}"
case "$P" in tmrkz-mover|tmrkz-test|tmrkz-clean|tmrkz-load) echo "refused: $P is not a disposable project" >&2; exit 2;; esac
EV="docs/evidence/migration-path/$LABEL"
mkdir -p "$EV" backups

. ops/test-env/prepare.sh
export MOVER_HTTP_PORT="$PORT" TMRKZ_PUBLIC_URL="http://localhost:$PORT" MOVER_URL="http://localhost:$PORT"
OVR="$EV/compose.image.yml"
# memory caps for the disposable stack only: the Docker VM is shared with other environments, and an uncapped JVM may
# grow towards 70 % of the VM (two Docker VM freezes on 4 Nov 2026)
printf 'services:\n  backend:\n    image: ${TMRKZ_BACKEND_IMAGE}\n    mem_limit: 1536m\n  keycloak:\n    mem_limit: 1g\n' > "$OVR"
compose() {
  docker compose -p "$P" -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml \
    -f "$OVR" "$@"
}
psqlq() { compose exec -T db psql -U mover -d mover -v ON_ERROR_STOP=1 -At "$@"; }
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
log() { echo "[migpath] $*" | tee -a "$EV/run.log"; }
cleanup() { [ "${KEEP:-0}" = 1 ] || compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
: > "$EV/run.log"

ready() {
  i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] \
     && [ "$(curl -s -o /dev/null -w '%{http_code}' "$MOVER_URL/api/v1/auth/status")" = 200 ]; do
    i=$((i + 1)); [ $i -gt 120 ] && { log "environment did not become ready"; exit 1; }; sleep 3
  done
}
healthy_on() {
  i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$P-backend-1" 2>/dev/null)" = healthy ] \
     && [ "$(docker inspect -f '{{.Config.Image}}' "$P-backend-1" 2>/dev/null)" = "$1" ]; do
    i=$((i + 1)); [ $i -gt 120 ] && { log "backend on $1 not healthy"; docker logs --tail 80 "$P-backend-1" >> "$EV/run.log" 2>&1; exit 1; }
    sleep 3
  done
}
history() {
  psqlq -c "select installed_rank, version, description, script, checksum, success, installed_on
              from flyway_schema_history order by installed_rank" > "$1"
}
migrations_in() {
  docker run --rm --entrypoint sh "$1" -c 'cd /tmp && unzip -o -q /opt/mover/mover-backend.jar "BOOT-INF/classes/db/migration/*" \
    && cd BOOT-INF/classes/db/migration && sha256sum V*.sql' | sort -t_ -k1.2n
}

log "project $P on :$PORT — from $FROM to $TO (expect pending: $EXPECT_PENDING)"
log "image ids: from $(docker image inspect -f '{{.Id}}' "$FROM"), to $(docker image inspect -f '{{.Id}}' "$TO")"
compose down -v >/dev/null 2>&1 || true

# 1. clean environment on the pre-migration release, fictional seed, business records through the application
TMRKZ_BACKEND_IMAGE="$FROM" compose up -d --no-build >> "$EV/run.log" 2>&1
ready
healthy_on "$FROM"
i=0
until [ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$P-test-seed-1" 2>/dev/null)" = "exited 0" ]; do
  i=$((i + 1)); [ $i -gt 60 ] && { log "fictional seed did not complete"; exit 1; }; sleep 2
done
log "seeded; creating business records on $FROM (journey)"
node tests/acceptance/journey.mjs > "$EV/journey-before.txt" 2>&1 || { log "journey on $FROM failed"; tail -20 "$EV/journey-before.txt"; exit 1; }
log "journey on $FROM: $(grep -c '^ok\|✓\|PASS' "$EV/journey-before.txt" || true) passing lines, last: $(tail -1 "$EV/journey-before.txt")"

# 2. schema before
history "$EV/flyway-history-before.txt"
compose exec -T db pg_dump -U mover -d mover --schema-only --no-owner -N tiger -N tiger_data -N topology > "$EV/schema-before.sql"
psqlq -f - < ops/sql/upgrade-rows.sql | cut -d'|' -f1 | sort | uniq -c > "$EV/rows-before.txt"
log "schema before: $(tail -1 "$EV/flyway-history-before.txt" | cut -d'|' -f2,3) — schema sha256 $(sha "$EV/schema-before.sql")"

# 3. plan: migrations shipped in TO that the database has not applied
migrations_in "$TO" > "$EV/migrations-in-to-image.txt"
psqlq -c "select version from flyway_schema_history where success and version is not null" | sort > "$EV/applied.txt"
: > "$EV/plan.txt"
while read -r h f; do
  v="${f#V}"; v="${v%%__*}"
  grep -qx "$v" "$EV/applied.txt" || echo "$v $f sha256=$h" >> "$EV/plan.txt"
done < "$EV/migrations-in-to-image.txt"
PLANNED="$(cut -d' ' -f1 "$EV/plan.txt" | tr '\n' ' ' | sed 's/ $//')"
log "plan: pending [$PLANNED]"
[ "$PLANNED" = "$EXPECT_PENDING" ] || { log "REFUSED: plan [$PLANNED] differs from the expected [$EXPECT_PENDING]; nothing applied"; exit 1; }

# 4. backup with manifest, restore proof, row fingerprints before
sh ops/backup.sh "$P" backups > "$EV/backup.txt" 2>&1
BK="$(tail -1 "$EV/backup.txt")"
cp "$BK/manifest.json" "$EV/backup-manifest.json"
log "backup $BK (schemaVersion $(grep -o '"schemaVersion": "[^"]*"' "$BK/manifest.json"))"
if [ "${VERIFY_RESTORE:-1}" = 1 ]; then
  sh ops/verify-restore.sh "$P" > "$EV/verify-restore.txt" 2>&1 || { log "restore proof FAILED"; tail -20 "$EV/verify-restore.txt"; exit 1; }
  log "restore proof: $(grep -E 'PASS|FAIL' "$EV/verify-restore.txt" | tail -1)"
fi
sh ops/upgrade-check.sh before "$P" > "$EV/upgrade-check-before.txt" 2>&1
log "$(tail -1 "$EV/upgrade-check-before.txt")"

# 5. the release: start TO; Flyway applies the pending migrations on start
TMRKZ_BACKEND_IMAGE="$TO" compose up -d --no-build backend >> "$EV/run.log" 2>&1
healthy_on "$TO"
TMRKZ_BACKEND_IMAGE="$TO" compose restart web >> "$EV/run.log" 2>&1
ready
docker logs "$P-backend-1" 2>&1 | grep -iE "flyway|migrat|schema .* (is up to date|now at)" > "$EV/backend-flyway-log.txt" || true
log "backend on $TO healthy; flyway: $(grep -iE 'Successfully applied|up to date' "$EV/backend-flyway-log.txt" | tail -1 | sed 's/.*INFO[^:]*: //')"

# 6. schema history, schema after, integrity
history "$EV/flyway-history-after.txt"
compose exec -T db pg_dump -U mover -d mover --schema-only --no-owner -N tiger -N tiger_data -N topology > "$EV/schema-after.sql"
diff -u "$EV/schema-before.sql" "$EV/schema-after.sql" > "$EV/schema-diff.txt" || true
psqlq -f - < ops/sql/upgrade-rows.sql | cut -d'|' -f1 | sort | uniq -c > "$EV/rows-after.txt"
if sh ops/upgrade-check.sh after "$P" > "$EV/upgrade-check-after.txt" 2>&1; then UPG=PASS; else UPG=FAIL; fi
log "$(tail -1 "$EV/upgrade-check-after.txt")"
for v in $EXPECT_PENDING; do
  psqlq -c "select version, success, checksum, installed_on from flyway_schema_history where version = '$v'" | grep -q "|t|" \
    || { log "history: version $v not recorded as successful"; UPG=FAIL; }
done
if [ -n "${AFTER_SQL:-}" ]; then
  psqlq -f - < "$AFTER_SQL" > "$EV/after-checks.txt" 2>&1 || UPG=FAIL
  log "after checks: $(tr '\n' ' ' < "$EV/after-checks.txt")"
  grep -q "mismatches=0" "$EV/after-checks.txt" || { log "after checks did not confirm the data"; UPG=FAIL; }
fi

# 7. compatibility: the full journey again, on the migrated database and the new release
if node tests/acceptance/journey.mjs > "$EV/journey-after.txt" 2>&1; then JNY=PASS; else JNY=FAIL; fi
log "journey on $TO: $JNY — $(tail -1 "$EV/journey-after.txt")"

cat > "$EV/summary.txt" <<EOF
label=$LABEL project=$P (disposable, removed after the run unless KEEP=1)
from=$FROM to=$TO
planned=[$PLANNED] expected=[$EXPECT_PENDING]
schema-before sha256=$(sha "$EV/schema-before.sql") schema-after sha256=$(sha "$EV/schema-after.sql")
schema diff lines (+/-)=$(grep -c '^[+-][^+-]' "$EV/schema-diff.txt" || true)
backup=$BK
upgrade-check=$UPG journey-after=$JNY
EOF
log "summary: upgrade-check=$UPG journey-after=$JNY"
[ "$UPG" = PASS ] && [ "$JNY" = PASS ]
