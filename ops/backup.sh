#!/usr/bin/env sh
# Consistent backup of a MOVER deployment: database (business data, identities, policies, form/workflow versions,
# Flowable runtime + history, audit), attachment/export files and installed map packages, plus a manifest with
# SHA-256 checksums and record counts.
#
# Usage: ops/backup.sh [compose-project] [output-root]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
PROJECT="${1:-tmrkz-mover}"
OUT_ROOT="${2:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$PROJECT-$STAMP"
mkdir -p "$OUT"
dc() { docker compose -p "$PROJECT" "$@"; }

echo "[backup] database → $OUT/db.dump"
dc exec -T db pg_dump -U mover -d mover -Fc --no-owner > "$OUT/db.dump"

echo "[backup] identity database → $OUT/keycloak.dump"
dc exec -T db pg_dump -U mover -d keycloak -Fc --no-owner > "$OUT/keycloak.dump"
dc exec -T db psql -U mover -d keycloak -At -c "select 'realms', count(*) from realm union all select 'users', count(*) from user_entity union all select 'clients', count(*) from client" > "$OUT/identity-fingerprint.txt"

echo "[backup] authorisation database → $OUT/openfga.dump"
dc exec -T db pg_dump -U mover -d openfga -Fc --no-owner > "$OUT/openfga.dump"

echo "[backup] files volume → $OUT/files.tgz"
dc exec -T backend tar czf - -C /var/lib/mover . > "$OUT/files.tgz"

echo "[backup] map packages → $OUT/map-packages.tgz"
dc exec -T backend tar czf - -C /opt/mover/map-packages . > "$OUT/map-packages.tgz"

echo "[backup] fingerprints"
dc exec -T db psql -U mover -d mover -At -f - < ops/sql/fingerprint.sql > "$OUT/fingerprint.txt"

sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
SCHEMA="$(dc exec -T db psql -U mover -d mover -Atc "select max(version) from flyway_schema_history where success")"
cat > "$OUT/manifest.json" <<EOF
{
  "project": "$PROJECT",
  "createdAt": "$STAMP",
  "application": "mover-backend 1.0.0",
  "schemaVersion": "$SCHEMA",
  "files": {
    "db.dump": "$(sha "$OUT/db.dump")",
    "keycloak.dump": "$(sha "$OUT/keycloak.dump")",
    "openfga.dump": "$(sha "$OUT/openfga.dump")",
    "identity-fingerprint.txt": "$(sha "$OUT/identity-fingerprint.txt")",
    "files.tgz": "$(sha "$OUT/files.tgz")",
    "map-packages.tgz": "$(sha "$OUT/map-packages.tgz")",
    "fingerprint.txt": "$(sha "$OUT/fingerprint.txt")"
  }
}
EOF
echo "[backup] done: $OUT"
echo "$OUT"
