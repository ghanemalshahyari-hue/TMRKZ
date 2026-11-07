#!/usr/bin/env sh
# Loads the acceptance data into the one application on :8088 and prints the run's namespace. See provision.mjs and README.md.
#   sh ops/acceptance-main/provision.sh backups/<dir-verified-by-verify-backup>
set -eu
cd "$(dirname "$0")/../.."
mkdir -p ops/acceptance-main/.generated
L=ops/acceptance-main/.generated/last-provision.log
node ops/acceptance-main/provision.mjs "$1" > "$L" || { cat "$L"; exit 1; }
cat "$L"
export $(grep '^ACC_NS=' "$L")
MOVER_URL=http://localhost:8088 TERRAIN_VERSION=2026.11 ACC_MAX_FOOTPRINT=500000 ACC_POLICY_NOTE="ACCEPTANCE / FICTIONAL · $ACC_PREFIX" node tests/acceptance/owner-review-setup.mjs
sed -e "s/__NS__/$ACC_NS/g" -e "s/__PFX__/$ACC_PREFIX/g" -e "s/__DY__/0/g" ops/acceptance-main/areas.sql | docker exec -i tmrkz-mover-db-1 psql -X -q -U mover -d mover -v ON_ERROR_STOP=1 -f -
echo "[acceptance] ready on http://localhost:8088"
