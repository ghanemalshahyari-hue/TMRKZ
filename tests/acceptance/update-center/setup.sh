#!/usr/bin/env sh
# Update Center acceptance (ADR-104): a throw-away installation laid out like the VM's /data/TMRKZ, started with the same
# images, the same folder-based Compose files and start.sh, plus a «Desktop» copy of the same folder to update it from.
# Fictional data only; the owner's installation (Compose project tmrkz) is never touched: this one is tmrkz-vmsim.
#
#   sh tests/acceptance/update-center/setup.sh <empty-or-previous-base-dir> [port]
#   then: node tests/acceptance/update-center.mjs <base-dir> [port]
#   remove: (cd <base>/vm/TMRKZ && docker compose down -v) && rm -rf <base>
set -eu
export MSYS_NO_PATHCONV=1
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="${1:?base directory}"
PORT="${2:-8188}"
mkdir -p "$BASE"
BASE="$(cd "$BASE" && pwd)"
VM="$BASE/vm/TMRKZ"
DESK="$BASE/desk/TMRKZ"
[ ! -e "$BASE/vm" ] || [ -f "$BASE/.tmrkz-update-acceptance" ] || { echo "refused: $BASE has a vm/ this script did not make"; exit 2; }
if [ -d "$VM" ]; then (cd "$VM" && docker compose down -v >/dev/null 2>&1 || true); fi
rm -rf "$BASE/vm" "$BASE/desk"
touch "$BASE/.tmrkz-update-acceptance"

# 1. the application files of this folder — exactly the ones a release carries (managed-paths.conf), nothing else
(cd "$SRC" && sh ops/update/make-release.sh >/dev/null)
for dir in "$VM" "$DESK"; do
  mkdir -p "$dir"
  cut -f4 "$SRC/release/MANIFEST.tsv" | (cd "$SRC" && tar -cf - -T -) | (cd "$dir" && tar -xf -)
done

# 2. the machine's own parts, as on the VM: .env with its own project name, a third Compose file named in COMPOSE_FILE,
#    certificates, backups and an offline map root (this machine's map, read-only)
MAPS="$(cd "$SRC" && pwd -W 2>/dev/null || pwd)/map-data/runtime"
cat > "$VM/.env" <<EOF
COMPOSE_PROJECT_NAME=tmrkz-vmsim
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml
TMRKZ_IP=localhost
TMRKZ_PORT=$PORT
TMRKZ_MAP_ROOT=$MAPS
TMRKZ_STATIONING_V3=true
EOF
cat > "$VM/docker-compose.dc-hosts.yml" <<'EOF'
# VM-specific (fictional for the acceptance test): the directory servers by name
services:
  backend:
    extra_hosts:
      - "dc1.example.test:192.0.2.10"
EOF
mkdir -p "$VM/certs" "$VM/backups" "$VM/map-runtime"
printf 'fictional certificate for the acceptance test\n' > "$VM/certs/vm-test.pem"

# 3. a release key on the «Desktop» copy; its public key installed once on the VM (the one-time bootstrap step)
(cd "$DESK" && sh ops/update/make-release.sh --init-key >/dev/null)
mkdir -p "$VM/ops/local/.generated"
cp "$DESK/ops/local/.generated/release-signing.pub" "$VM/ops/local/.generated/release-trust.pub"

# 4. never the owner's project
NAME="$(cd "$VM" && docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: //p' | head -n 1)"
[ "$NAME" = "tmrkz-vmsim" ] || { echo "refused: the Compose project would be «$NAME», not tmrkz-vmsim"; exit 2; }

# 5. start it the way the VM starts (no tmrkz-images.tar in this folder: the loaded images are used)
(cd "$VM" && TMRKZ_IP=localhost TMRKZ_PORT="$PORT" sh start.sh)
echo "VM: $VM  (http://localhost:$PORT)"
echo "Desktop copy: $DESK"
