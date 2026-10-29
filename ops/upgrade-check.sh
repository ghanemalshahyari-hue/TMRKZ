#!/usr/bin/env sh
# Verifies that an application upgrade preserved existing records (sites, boundaries, requests, revisions, decisions,
# approval documents, reservations and their locks, attachments, audit, map packages).
#   sh ops/upgrade-check.sh before [compose-project]   # run on the old version, before `docker compose up --build`
#   sh ops/upgrade-check.sh after  [compose-project]   # run after the upgrade; fails if any earlier row changed or vanished
# Rows added after the upgrade are allowed. Columns added by a migration are not part of the comparison
# (see ops/sql/upgrade-rows.sql). Output files: backups/upgrade-<project>-{before,after}.txt (git-ignored).
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
PHASE="${1:?before|after}"
PROJECT="${2:-tmrkz-mover}"
mkdir -p backups
OUT="backups/upgrade-$PROJECT-$PHASE.txt"
docker compose -p "$PROJECT" exec -T db psql -U mover -d mover -At -f - < ops/sql/upgrade-rows.sql > "$OUT"
echo "[upgrade-check] $PHASE: $(wc -l < "$OUT") rows fingerprinted → $OUT"
if [ "$PHASE" = "after" ]; then
  BEFORE="backups/upgrade-$PROJECT-before.txt"
  [ -f "$BEFORE" ] || { echo "run 'before' on the old version first" >&2; exit 2; }
  MISSING="$(sort "$BEFORE" > "$BEFORE.sorted"; sort "$OUT" > "$OUT.sorted"; comm -23 "$BEFORE.sorted" "$OUT.sorted")"
  rm -f "$BEFORE.sorted" "$OUT.sorted"
  if [ -n "$MISSING" ]; then
    echo "[upgrade-check] FAIL: rows changed or missing after the upgrade:" >&2
    echo "$MISSING" | cut -d'|' -f1,2 >&2
    exit 1
  fi
  echo "[upgrade-check] PASS: all $(wc -l < "$BEFORE") earlier rows are present and unchanged"
fi
