#!/usr/bin/env sh
# The single local TMRKZ installation (owner decision of 6 Nov 2026): the production project tmrkz-mover on
# TMRKZ_PUBLIC_URL (default http://localhost:8088), started empty, with no test data and no test accounts. Only the two
# lasting platform accounts exist (admin, developer; passwords in .env, see ops/platform-accounts.sh). Until the
# enterprise directory is configured, a local stand-in directory with no people is used (compose.local-directory.yml).
# Once .env names the enterprise directory (LDAP_URL set and not the stand-in, ADR-052), the stand-in is left out: the
# directory settings, the organisation's CA in TMRKZ_TRUSTSTORE_DIR (default ops/keycloak/truststores) and .env apply as in
# production. The federation inside Keycloak is then pointed at it with ops/keycloak/set-directory.sh.
# Usage: sh ops/local/up.sh          (offline, from this folder's saved images: sh ops/local/offline.sh)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
sh ops/init-env.sh >/dev/null
URL="$(sed -n 's/^TMRKZ_PUBLIC_URL=//p' .env | tail -n 1)"; URL="${URL:-http://localhost:8088}"
# readiness is checked on this host's plain port: an https name may resolve only in the organisation's DNS (ADR-051)
PORT="$(sed -n 's/^MOVER_HTTP_PORT=//p' .env | tail -n 1)"; LOCAL="http://127.0.0.1:${PORT:-8088}"
DIRECTORY="$(sed -n 's/^LDAP_URL=//p' .env | tail -n 1 | tr -d '\r')"
# offline (ops/local/offline.sh, owner 16 Nov 2026): nothing is built or pulled and the application network has no route out;
# on a machine without the data TMRKZ_RESTORE names the backup restored (databases and files) before the start
UP="--build"; OFF=""
if [ "${TMRKZ_OFFLINE:-}" = 1 ]; then UP="--no-build --pull never"; OFF="-f ops/local/compose.offline.yml"; fi
# a new version built on this connected machine while the application stays on its isolated network
if [ "${TMRKZ_OFFLINE:-}" = 1 ] && [ "${TMRKZ_BUILD:-}" = 1 ]; then UP="--build"; fi
# Optional manual enterprise-LDAP override: keep Keycloak/local platform accounts on the stand-in and attach only the
# fixed raw-TLS relay of compose.enterprise-manual.yml. Its generated gateway belongs to this compose network.
MANUAL="$(sed -n 's/^TMRKZ_MANUAL_LDAP_URL=//p' .env | tail -n 1 | tr -d '\r' | tr -d "'\"")"
MANUAL_FILE=""; MANUAL_OPT=""
if [ -n "$MANUAL" ]; then
  MANUAL_FILE=":ops/local/compose.enterprise-manual.yml"
  MANUAL_OPT="-f ops/local/compose.enterprise-manual.yml"
fi
# Nginx drops Compose group_add values when it becomes the nginx user. Preserve the map mount's numeric group in
# /etc/group instead (map-worker.sh), which is required on vboxsf mounts that ignore chmod and retain mode 0770.
MAP_ROOT="$(sed -n 's/^TMRKZ_MAP_ROOT=//p' .env | tail -n 1 | tr -d '\r')"; MAP_ROOT="${MAP_ROOT:-./map-runtime}"
MAP_GID=0
if [ -d "$MAP_ROOT" ]; then
  MAP_GID="$(stat -c %g "$MAP_ROOT" 2>/dev/null || stat -f %g "$MAP_ROOT")"
fi
export TMRKZ_MAP_GID="$MAP_GID"
MAP_FILE=":ops/local/compose.map-access.yml"; MAP_OPT="-f ops/local/compose.map-access.yml"
restore() {
  [ -n "${TMRKZ_RESTORE:-}" ] || return 0
  COMPOSE_PATH_SEPARATOR=":" COMPOSE_FILE="$1${OFF:+:ops/local/compose.offline.yml}${MANUAL_FILE}${MAP_FILE}" RESTORE_DATA_ONLY=1 \
    sh ops/restore.sh "$TMRKZ_RESTORE" tmrkz-mover "${PORT:-8088}"
}
case "$DIRECTORY" in
  ""|ldap://openldap*) ;;
  *)
    echo "[up] enterprise directory from .env: $DIRECTORY (no stand-in)"
    restore docker-compose.yml
    docker compose -p tmrkz-mover -f docker-compose.yml $OFF $MANUAL_OPT $MAP_OPT up -d $UP "$@"
    STANDIN=no ;;
esac
if [ "${STANDIN:-yes}" = yes ]; then
G=ops/local/.generated
mkdir -p "$G/certs" "$G/ldap" "$G/truststore"
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
[ -f "$G/ldap-admin-password" ] || rand 24 > "$G/ldap-admin-password"
if [ ! -f "$G/certs/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=TMRKZ Local Directory CA" \
    -keyout "$G/certs/ca.key" -out "$G/certs/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=openldap" -keyout "$G/certs/ldap.key" -out "$G/certs/ldap.csr" 2>/dev/null
  printf 'subjectAltName=DNS:openldap\nextendedKeyUsage=serverAuth\n' > "$G/certs/ext.cnf"
  openssl x509 -req -in "$G/certs/ldap.csr" -CA "$G/certs/ca.crt" -CAkey "$G/certs/ca.key" -CAcreateserial -days 825 \
    -extfile "$G/certs/ext.cnf" -out "$G/certs/ldap.crt" 2>/dev/null
  rm -f "$G/certs/ldap.csr" "$G/certs/ext.cnf"
fi
cp "$G/certs/ca.crt" "$G/truststore/tmrkz-local-directory-ca.pem"
# Some shared filesystems retain 0770 on chmod; Keycloak is uid 1000 and cannot enter that bind mount.
LOCAL_TRUSTSTORE="${TMRKZ_LOCAL_TRUSTSTORE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tmrkz-mover/local-truststore}"
mkdir -p "$LOCAL_TRUSTSTORE"
cp "$G/certs/ca.crt" "$LOCAL_TRUSTSTORE/tmrkz-local-directory-ca.pem"
chmod 755 "$LOCAL_TRUSTSTORE"
chmod 644 "$LOCAL_TRUSTSTORE/"*.pem
# the users container only: no person is created here
printf 'dn: ou=people,dc=tmrkz,dc=local\nobjectClass: organizationalUnit\nou: people\n' > "$G/ldap/50-people-container.ldif"

export LOCAL_LDAP_ADMIN_PASSWORD="$(cat "$G/ldap-admin-password")"
export LDAP_URL="ldap://openldap:389" LDAP_START_TLS="true" LDAP_BIND_DN="cn=admin,dc=tmrkz,dc=local"
export LDAP_BIND_CREDENTIAL="$LOCAL_LDAP_ADMIN_PASSWORD" LDAP_USERS_DN="ou=people,dc=tmrkz,dc=local"
export TMRKZ_TRUSTSTORE_DIR="$LOCAL_TRUSTSTORE"

restore docker-compose.yml:ops/local/compose.local-directory.yml
docker compose -p tmrkz-mover -f docker-compose.yml -f ops/local/compose.local-directory.yml $OFF $MANUAL_OPT $MAP_OPT up -d $UP "$@"
fi
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] \
   && [ "$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/api/v1/auth/status")" = 200 ]; do
  i=$((i + 1)); [ $i -gt 120 ] && { echo "TMRKZ did not become ready at $URL"; exit 1; }; sleep 3
done
# right after its first start Keycloak may still refuse the administration login for a few seconds
i=0
until sh ops/platform-accounts.sh tmrkz-mover; do
  i=$((i + 1)); [ $i -ge 5 ] && { echo "platform accounts not created; re-run: sh ops/platform-accounts.sh tmrkz-mover"; exit 1; }; sleep 10
done
sh ops/keycloak/set-platform-password-client.sh tmrkz-mover
echo "TMRKZ is up at $URL — sign in as admin or developer (passwords: TMRKZ_PLATFORM_*_PASSWORD in .env)"
