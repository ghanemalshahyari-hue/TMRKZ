#!/usr/bin/env sh
# Restores a backup produced by ops/backup.sh into a CLEAN compose project (no existing database volume).
# Checksums from the manifest are verified before anything is restored.
#
# Usage: ops/restore.sh <backup-dir> [target-project] [http-port]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
SRC="$1"
PROJECT="${2:-tmrkz-mover}"
PORT="${3:-8088}"
dc() { MOVER_HTTP_PORT="$PORT" docker compose -p "$PROJECT" "$@"; }
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

FILES="db.dump files.tgz map-packages.tgz fingerprint.txt"
[ -f "$SRC/keycloak.dump" ] && FILES="$FILES keycloak.dump identity-fingerprint.txt"
[ -f "$SRC/openfga.dump" ] && FILES="$FILES openfga.dump"
for f in $FILES; do
  expected="$(grep "\"$f\"" "$SRC/manifest.json" | sed 's/.*: "\([0-9a-f]*\)".*/\1/')"
  actual="$(sha "$SRC/$f")"
  if [ "$expected" != "$actual" ]; then echo "[restore] checksum mismatch for $f — aborting"; exit 1; fi
done
echo "[restore] manifest checksums verified"

if [ -n "$(docker volume ls -q --filter name="^${PROJECT}_db-data$")" ]; then
  echo "[restore] volume ${PROJECT}_db-data already exists. Restore targets a clean environment;"
  echo "          remove it deliberately (docker compose -p $PROJECT down -v) after taking a fresh backup."
  exit 1
fi

dc up -d db
# A clean volume is initialised first (the PostGIS image runs its init scripts on a temporary server, then restarts):
# wait for the end of initialisation, not only for the first accepted connection.
until dc logs db 2>/dev/null | grep -q "PostgreSQL init process complete"; do sleep 2; done
until dc exec -T db pg_isready -U mover -d mover >/dev/null 2>&1; do sleep 2; done
sleep 2
echo "[restore] database"
dc exec -T db pg_restore -U mover -d mover --no-owner --exit-on-error < "$SRC/db.dump"

dc run --rm db-init >/dev/null
if [ -f "$SRC/keycloak.dump" ]; then
  echo "[restore] identity database"
  dc exec -T db pg_restore -U mover -d keycloak --no-owner --role=keycloak --exit-on-error < "$SRC/keycloak.dump"
fi
# The authorisation store is restored with the business database it was built from. A backup without it is still
# usable: the backend then creates a new store and rebuilds every tuple from the restored grants (ADR-018).
if [ -f "$SRC/openfga.dump" ]; then
  echo "[restore] authorisation database"
  dc exec -T db pg_restore -U mover -d openfga --no-owner --role=openfga --exit-on-error < "$SRC/openfga.dump"
fi

echo "[restore] files"
dc create backend >/dev/null 2>&1 || true
docker run --rm -i --entrypoint sh -v "${PROJECT}_files:/var/lib/mover" -u 0 mover/backend:1.0.0 \
  -c "tar xzf - -C /var/lib/mover && chown -R mover:mover /var/lib/mover" < "$SRC/files.tgz"

echo "[restore] starting application"
dc up -d
echo "[restore] done — verify with ops/verify-restore.sh"
