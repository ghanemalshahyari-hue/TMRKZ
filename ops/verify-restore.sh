#!/usr/bin/env sh
# AT-30: proves a backup restores into a clean environment with identical requests, decisions, approval documents,
# reservations, form/workflow/policy versions, audit trail and attachment content.
#
# 1. backs up the source project, 2. restores it into a throw-away project on another port,
# 3. compares table fingerprints and the SHA-256 of every stored attachment, 4. removes the throw-away project.
#
# Usage: ops/verify-restore.sh [source-project]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
SOURCE="${1:-tmrkz-mover}"
TARGET="${SOURCE}-restoretest"
PORT=18088

BACKUP="$(sh ops/backup.sh "$SOURCE" backups | tail -1)"
cleanup() { docker compose -p "$TARGET" down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
sh ops/restore.sh "$BACKUP" "$TARGET" "$PORT"

echo "[verify] waiting for restored backend"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "${TARGET}-backend-1" 2>/dev/null)" = "healthy" ]; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "[verify] restored backend not healthy"; exit 1; }; sleep 3
done

docker compose -p "$TARGET" exec -T db psql -U mover -d mover -At -f - < ops/sql/fingerprint.sql > "$BACKUP/fingerprint.restored.txt"
if [ -f "$BACKUP/keycloak.dump" ]; then
  docker compose -p "$TARGET" exec -T db psql -U mover -d keycloak -At -c "select 'realms', count(*) from realm union all select 'users', count(*) from user_entity union all select 'clients', count(*) from client" > "$BACKUP/identity-fingerprint.restored.txt"
  if diff -q "$BACKUP/identity-fingerprint.txt" "$BACKUP/identity-fingerprint.restored.txt" >/dev/null; then
    echo "[verify] identity realm, users and clients identical"
  else
    echo "[verify] identity database differs after restore"; diff "$BACKUP/identity-fingerprint.txt" "$BACKUP/identity-fingerprint.restored.txt" || true; exit 1
  fi
fi
# The restored application registers nothing new on start-up (map packages are already installed), so every
# fingerprint must match exactly.
if diff "$BACKUP/fingerprint.txt" "$BACKUP/fingerprint.restored.txt"; then
  echo "[verify] table fingerprints identical ($(wc -l < "$BACKUP/fingerprint.txt") tables)"
else
  echo "[verify] FINGERPRINT MISMATCH"; exit 1
fi

docker compose -p "$TARGET" exec -T db psql -U mover -d mover -At \
  -c "select storage_key || ' ' || sha256 from attachment where storage_key is not null order by 1" > "$BACKUP/attachments.expected"
COUNT=0
while read -r key sum; do
  [ -z "$key" ] && continue
  actual="$(docker compose -p "$TARGET" exec -T backend sha256sum "/var/lib/mover/$key" < /dev/null | cut -d' ' -f1)"
  if [ "$actual" != "$sum" ]; then echo "[verify] attachment content mismatch: $key"; exit 1; fi
  COUNT=$((COUNT+1))
done < "$BACKUP/attachments.expected"
echo "[verify] $COUNT attachment files match their recorded SHA-256"

STATUS=000
for _ in $(seq 1 30); do
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/v1/system/health" || true)"
  [ "$STATUS" = "200" ] && break
  sleep 2
done
[ "$STATUS" = "200" ] || { echo "[verify] restored web entry point not answering ($STATUS)"; exit 1; }
echo "[verify] restored stack answers on :$PORT — AT-30 PASSED"
