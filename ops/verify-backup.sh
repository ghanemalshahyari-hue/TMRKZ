#!/usr/bin/env sh
# Verifies a backup produced by ops/backup.sh before anything relies on it (an upgrade applies migrations only after
# this passes): 1. every file matches its manifest SHA-256; 2. every dump is a readable archive; 3. the business
# database dump restores, as ops/restore.sh restores it, into a throw-away PostGIS container (no port, memory-capped,
# removed afterwards) whose table counts equal the backup's fingerprint.txt and whose schema version equals the
# manifest's; 4. optionally, its rows (ops/sql/upgrade-rows.sql) equal a fingerprint taken from the live database
# right after the backup, so the backup holds exactly the state being upgraded.
#
# Usage: sh ops/verify-backup.sh <backup-dir> [live-upgrade-rows-file]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
SRC="${1:?backup directory}"
LIVE="${2:-}"
IMAGE=postgis/postgis:17-3.5-alpine
C="tmrkz-backupcheck-$(date -u +%Y%m%d%H%M%S)"
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
fail() { echo "[verify-backup] FAIL: $*" >&2; exit 1; }

[ -f "$SRC/manifest.json" ] || fail "no manifest.json in $SRC"
FILES="$(sed -n 's/^ *"\([^"]*\)": "\([0-9a-f]\{64\}\)".*/\1/p' "$SRC/manifest.json")"
[ -n "$FILES" ] || fail "manifest lists no files"
for f in $FILES; do
  expected="$(grep "\"$f\"" "$SRC/manifest.json" | sed 's/.*: "\([0-9a-f]*\)".*/\1/')"
  [ -f "$SRC/$f" ] || fail "$f listed in the manifest but missing"
  [ "$(sha "$SRC/$f")" = "$expected" ] || fail "checksum mismatch for $f"
done
echo "[verify-backup] 1. manifest checksums: $(echo "$FILES" | wc -w | tr -d ' ') files match"

for t in files.tgz map-packages.tgz; do
  [ -f "$SRC/$t" ] && { gzip -t "$SRC/$t" || fail "$t is not a readable gzip archive"; }
done
for d in db.dump keycloak.dump openfga.dump; do
  [ -f "$SRC/$d" ] || continue
  n="$(docker run --rm -i --entrypoint pg_restore "$IMAGE" --list < "$SRC/$d" | grep -c ';' || true)"
  [ "$n" -gt 0 ] || fail "$d is not a readable pg_dump archive"
  echo "[verify-backup] 2. $d readable ($n catalogue lines)"
done

cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$C" --memory 1g -e POSTGRES_USER=mover -e POSTGRES_DB=mover -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" >/dev/null
until docker logs "$C" 2>&1 | grep -q "PostgreSQL init process complete"; do sleep 2; done
until docker exec "$C" pg_isready -U mover -d mover >/dev/null 2>&1; do sleep 1; done
sleep 2
docker exec -i "$C" pg_restore -U mover -d mover --no-owner --exit-on-error < "$SRC/db.dump" || fail "db.dump does not restore"
q() { docker exec -i "$C" psql -X -U mover -d mover -At -v ON_ERROR_STOP=1 "$@"; }
q -f - < ops/sql/fingerprint.sql > "$SRC/fingerprint.backupcheck.txt"
diff "$SRC/fingerprint.txt" "$SRC/fingerprint.backupcheck.txt" >/dev/null \
  || { diff "$SRC/fingerprint.txt" "$SRC/fingerprint.backupcheck.txt" >&2 || true; fail "restored table counts differ from fingerprint.txt"; }
echo "[verify-backup] 3. db.dump restored; table counts equal fingerprint.txt ($(wc -l < "$SRC/fingerprint.txt") tables)"
SCHEMA="$(q -c "select max(version::int) from flyway_schema_history where success and version is not null")"
MANIFEST_SCHEMA="$(sed -n 's/^ *"schemaVersion": "\([0-9]*\)".*/\1/p' "$SRC/manifest.json")"
[ "$SCHEMA" = "$MANIFEST_SCHEMA" ] || fail "restored schema version $SCHEMA, manifest says $MANIFEST_SCHEMA"
echo "[verify-backup]    restored schema version $SCHEMA equals the manifest"

if [ -n "$LIVE" ]; then
  q -f - < ops/sql/upgrade-rows.sql | sort > "$SRC/upgrade-rows.backupcheck.txt"
  sort "$LIVE" | cmp -s - "$SRC/upgrade-rows.backupcheck.txt" \
    || fail "restored rows differ from the live fingerprint $LIVE (the database changed between backup and fingerprint?)"
  echo "[verify-backup] 4. restored rows equal the live fingerprint ($(wc -l < "$LIVE" | tr -d ' ') rows)"
fi
echo "[verify-backup] PASS: $SRC"
