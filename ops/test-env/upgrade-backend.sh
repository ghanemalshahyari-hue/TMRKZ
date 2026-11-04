#!/usr/bin/env sh
# Upgrades the ACCEPTANCE environment's backend to a release image by the documented sequence (docs/OPERATIONS.md
# "Upgrade and rollback"), never by rebuilding (up.sh would build from the working tree and apply whatever it contains):
# target identity (the database comment must say ACCEPTANCE) → plan (the migrations the image would apply must be
# exactly EXPECT_PENDING) → backup with manifest (ops/backup.sh) → ops/upgrade-check.sh before → backup verified
# (ops/verify-backup.sh: checksums, readable dumps, a restore whose rows equal the live fingerprint) → start the release
# image for the backend only (Flyway applies the plan on start) → flyway_schema_history → ops/upgrade-check.sh after →
# AFTER_SQL checks → health. Any refusal or failure before the image swap leaves the database untouched.
#
# Usage: EXPECT_PENDING="17" [AFTER_SQL=ops/sql/checks/V17-after.sql] sh ops/test-env/upgrade-backend.sh <image> <label>
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
IMAGE="${1:?release image}"
LABEL="${2:?label}"
EXPECT_PENDING="${EXPECT_PENDING:?versions the plan must contain exactly}"
P="${P:-tmrkz-test}"
case "$P" in tmrkz-mover) echo "refused: $P is an owner-retained production project" >&2; exit 2;; esac
EV="docs/evidence/acceptance-upgrade/$LABEL"
mkdir -p "$EV" backups
. ops/test-env/prepare.sh
OVR="$EV/compose.image.yml"
printf 'services:\n  backend:\n    image: ${TMRKZ_BACKEND_IMAGE}\n' > "$OVR"
# the same compose files the running environment was started with (e.g. the offline variant, whose network differs),
# so the upgrade changes the backend image and nothing else
WD="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$P-backend-1" 2>/dev/null | tr '\\\\' '/')"
CFG="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$P-backend-1" 2>/dev/null | tr '\\\\' '/')"
FILES=""
for f in $(echo "${CFG:-docker-compose.yml,ops/test-env/compose.directory.yml,ops/test-env/compose.data.yml}" | tr ',' ' '); do
  FILES="$FILES -f ${f#"$WD/"}"
done
compose() {
  # shellcheck disable=SC2086
  docker compose -p "$P" $FILES -f "$OVR" "$@"
}
psqlq() { docker exec -i "$P-db-1" psql -U mover -d mover -v ON_ERROR_STOP=1 -At "$@"; }
log() { echo "[upgrade] $*" | tee -a "$EV/run.log"; }
: > "$EV/run.log"

BEFORE_IMAGE="$(docker inspect -f '{{.Image}}' "$P-backend-1")"
log "project $P: backend $BEFORE_IMAGE → $IMAGE ($(docker image inspect -f '{{.Id}}' "$IMAGE"))"
log "image revision: $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}} built {{index .Config.Labels "org.opencontainers.image.created"}}' "$IMAGE" 2>/dev/null)"
# target identity: only a database labelled as acceptance data is upgraded by this tool
IDENT="$(psqlq -c "select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()")"
log "target $P-db-1 ($(docker inspect -f '{{.Id}}' "$P-db-1" | cut -c1-12)), database comment: ${IDENT:-none}"
case "$IDENT" in ACCEPTANCE*) ;; *) log "REFUSED: the database is not labelled ACCEPTANCE; nothing applied"; exit 1;; esac
log "schema version before: $(psqlq -c "select max(version::int) from flyway_schema_history where success and version is not null")"
psqlq -c "select installed_rank, version, description, checksum, success, installed_on from flyway_schema_history order by installed_rank" \
  > "$EV/flyway-history-before.txt"
docker exec "$P-db-1" pg_dump -U mover -d mover --schema-only --no-owner -N tiger -N tiger_data -N topology > "$EV/schema-before.sql"
log "schema fingerprint before: sha256 $(sha256sum "$EV/schema-before.sql" | cut -d' ' -f1)"

# plan
docker run --rm --entrypoint sh "$IMAGE" -c 'cd /tmp && unzip -o -q /opt/mover/mover-backend.jar "BOOT-INF/classes/db/migration/*" \
  && cd BOOT-INF/classes/db/migration && sha256sum V*.sql' | sort -t_ -k1.2n > "$EV/migrations-in-image.txt"
psqlq -c "select version from flyway_schema_history where success and version is not null" | sort > "$EV/applied.txt"
: > "$EV/plan.txt"
while read -r h f; do
  v="${f#V}"; v="${v%%__*}"
  grep -qx "$v" "$EV/applied.txt" || echo "$v $f sha256=$h" >> "$EV/plan.txt"
done < "$EV/migrations-in-image.txt"
PLANNED="$(cut -d' ' -f1 "$EV/plan.txt" | tr '\n' ' ' | sed 's/ $//')"
log "plan: pending [$PLANNED]"
[ "$PLANNED" = "$EXPECT_PENDING" ] || { log "REFUSED: plan [$PLANNED] differs from the expected [$EXPECT_PENDING]; nothing applied"; exit 1; }

# backup and fingerprints
sh ops/backup.sh "$P" backups > "$EV/backup.txt" 2>&1
BK="$(tail -1 "$EV/backup.txt")"
cp "$BK/manifest.json" "$EV/backup-manifest.json"
log "backup $BK"
sh ops/upgrade-check.sh before "$P" > "$EV/upgrade-check-before.txt" 2>&1
log "$(tail -1 "$EV/upgrade-check-before.txt")"
if sh ops/verify-backup.sh "$BK" "backups/upgrade-$P-before.txt" > "$EV/backup-verify.txt" 2>&1; then
  log "backup verified: $(grep -c '^\[verify-backup\] [0-9]' "$EV/backup-verify.txt") checks, $(tail -1 "$EV/backup-verify.txt")"
else
  log "REFUSED: backup verification failed ($(tail -1 "$EV/backup-verify.txt")); nothing applied"
  exit 1
fi

# release
TMRKZ_BACKEND_IMAGE="$IMAGE" compose up -d --no-build --no-deps backend >> "$EV/run.log" 2>&1
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$P-backend-1" 2>/dev/null)" = healthy ] \
   && [ "$(docker inspect -f '{{.Config.Image}}' "$P-backend-1")" = "$IMAGE" ]; do
  i=$((i + 1)); [ $i -gt 120 ] && { log "backend not healthy on $IMAGE"; docker logs --tail 60 "$P-backend-1" >> "$EV/run.log" 2>&1; exit 1; }
  sleep 3
done
docker restart "$P-web-1" >/dev/null
docker logs "$P-backend-1" 2>&1 | grep -iE "flyway|migrat|schema .* (is up to date|now at)" > "$EV/backend-flyway-log.txt" || true
log "backend healthy on $IMAGE; $(grep -iE 'Successfully applied|up to date' "$EV/backend-flyway-log.txt" | tail -1 | sed 's/.*INFO[^:]*: //')"

# after
psqlq -c "select installed_rank, version, description, checksum, success, installed_on from flyway_schema_history order by installed_rank" \
  > "$EV/flyway-history-after.txt"
docker exec "$P-db-1" pg_dump -U mover -d mover --schema-only --no-owner -N tiger -N tiger_data -N topology > "$EV/schema-after.sql"
diff -u "$EV/schema-before.sql" "$EV/schema-after.sql" > "$EV/schema-diff.txt" || true
if sh ops/upgrade-check.sh after "$P" > "$EV/upgrade-check-after.txt" 2>&1; then UPG=PASS; else UPG=FAIL; fi
log "$(tail -1 "$EV/upgrade-check-after.txt")"
for v in $EXPECT_PENDING; do
  grep -q "|$v|.*|t|" "$EV/flyway-history-after.txt" || { log "history: version $v not recorded as successful"; UPG=FAIL; }
done
if [ -n "${AFTER_SQL:-}" ]; then
  psqlq -f - < "$AFTER_SQL" > "$EV/after-checks.txt" 2>&1 || UPG=FAIL
  log "after checks: $(tr '\n' ' ' < "$EV/after-checks.txt")"
  grep -q "mismatches=0" "$EV/after-checks.txt" || { log "after checks did not confirm the data"; UPG=FAIL; }
fi
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "${TMRKZ_PUBLIC_URL:-http://localhost:8088}/api/v1/system/health")" = 200 ]; do
  i=$((i + 1)); [ $i -gt 40 ] && { log "health check failed"; UPG=FAIL; break; }; sleep 3
done
log "summary: upgrade-check=$UPG (rollback: ops/restore.sh $BK into a clean project with image $BEFORE_IMAGE)"
[ "$UPG" = PASS ]
