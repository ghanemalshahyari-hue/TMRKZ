#!/usr/bin/env sh
# Builds an offline installation bundle on a connected build host: pinned images (application + base images),
# compose file, scripts, map packages and documentation, with a SHA-256 manifest. Nothing in the bundle fetches
# from the internet when installed (no npm/Maven/registry access needed in the isolated environment).
#
# Usage: ops/airgap-bundle.sh [output-dir]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
OUT="${1:-offline-bundle}/mover-1.0.0"
rm -rf "$OUT"
mkdir -p "$OUT/images"

# Build only: the directory settings are required at run time, not to build images.
LDAP_URL="${LDAP_URL:-build-only}" LDAP_BIND_DN="${LDAP_BIND_DN:-build-only}" LDAP_BIND_CREDENTIAL="${LDAP_BIND_CREDENTIAL:-build-only}" \
  LDAP_USERS_DN="${LDAP_USERS_DN:-build-only}" docker compose build backend web keycloak
IMAGES="mover/backend:1.0.0 mover/web:1.0.0 tmrkz/keycloak:26.7.5-1 postgres:17.11-alpine"
for img in $IMAGES; do
  file="$OUT/images/$(echo "$img" | tr '/:' '__').tar"
  echo "[bundle] saving $img"
  docker save -o "$file" "$img"
  docker image inspect -f '{{.Id}}' "$img" > "$file.id"
done

cp docker-compose.yml .env.example "$OUT/"
mkdir -p "$OUT/ops/keycloak" && cp -r ops/*.sh ops/sql ops/db "$OUT/ops/" && cp -r ops/keycloak/truststores "$OUT/ops/keycloak/"
cp -r map-packages docs handoff README.md CLAUDE.md FONT-LICENSE.txt "$OUT/"
cat > "$OUT/install.sh" <<'EOF'
#!/usr/bin/env sh
# Offline install: loads images, prepares .env, starts the stack. See docs/INSTALL_AIRGAPPED.md.
set -eu
cd "$(dirname "$0")"
sha256sum -c SHA256SUMS
for t in images/*.tar; do docker load -i "$t"; done
sh ops/init-env.sh
grep -q "^LDAP_URL=." .env || { echo "Fill in the directory settings (LDAP_*) in .env and the CA in ops/keycloak/truststores, then rerun."; exit 1; }
docker compose up -d --no-build
echo "MOVER started — check: curl -s http://localhost:\${MOVER_HTTP_PORT:-8088}/api/v1/system/health"
EOF
chmod +x "$OUT/install.sh"
cp ops/init-env.sh "$OUT/ops/"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "[bundle] ready: $OUT ($(du -sh "$OUT" | cut -f1))"
