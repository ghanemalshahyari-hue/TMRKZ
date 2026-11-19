#!/usr/bin/env sh
# TMRKZ on this machine, from this folder (owner, 19 Nov 2026). Asks for the address people will open — the IP address and
# the port — writes them into .env, loads tmrkz-images.tar when its images are missing or newer, and starts everything.
# The same by hand:  set TMRKZ_IP and TMRKZ_PORT in .env,  docker load -i tmrkz-images.tar,  docker compose up -d
#   sh start.sh                                   asks
#   TMRKZ_IP=10.1.2.3 TMRKZ_PORT=8088 sh start.sh  does not ask
# On a new checkout it also creates .env (ops/init-env.sh) and the local directory's CA and password (ops/local/.generated).
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d '\r' | tr -d "'\""; }
# replaces or adds one setting without renaming .env (a shared folder may refuse a rename)
setenv() {
  awk -v k="$1" -v v="$2" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { sub(/\r$/, ""); print } END { if (!done) print k "=" v }' .env > .env.next && cat .env.next > .env && rm -f .env.next
}
addresses() {
  { hostname -I 2>/dev/null | tr ' ' '\n'; ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    ipconfig 2>/dev/null | sed -n 's/.*IPv4[^:]*:[^0-9]*\([0-9.]*\).*/\1/p'; } | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | awk '!s[$0]++' | tr '\n' ' '
}
code() {
  if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null -w '%{http_code}' "$1"
  else wget -q -S -O /dev/null "$1" 2>&1 | awk '/^ *HTTP\//{c=$2} END{print c+0}'; fi
}
# 0. a new checkout, or a .env from an older version: the missing secrets are added (ops/init-env.sh never changes an existing
#    value) and, while .env names no enterprise directory, the local stand-in directory gets its own CA and password
sh ops/init-env.sh >/dev/null
G=ops/local/.generated
LDAP="$(value LDAP_URL)"
if [ -z "$LDAP" ] || [ "$LDAP" = "ldap://openldap:389" ]; then
  mkdir -p "$G/certs" "$G/ldap" "$G/truststore"
  [ -s "$G/ldap-admin-password" ] || head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > "$G/ldap-admin-password"
  if [ ! -f "$G/certs/ca.crt" ]; then
    echo "  creating the local directory's certificate authority"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=TMRKZ Local Directory CA" \
      -keyout "$G/certs/ca.key" -out "$G/certs/ca.crt" 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=openldap" -keyout "$G/certs/ldap.key" -out "$G/certs/ldap.csr" 2>/dev/null
    printf 'subjectAltName=DNS:openldap\nextendedKeyUsage=serverAuth\n' > "$G/certs/ext.cnf"
    openssl x509 -req -in "$G/certs/ldap.csr" -CA "$G/certs/ca.crt" -CAkey "$G/certs/ca.key" -CAcreateserial -days 825 \
      -extfile "$G/certs/ext.cnf" -out "$G/certs/ldap.crt" 2>/dev/null
    rm -f "$G/certs/ldap.csr" "$G/certs/ext.cnf"
    cp "$G/certs/ca.crt" "$G/truststore/tmrkz-local-directory-ca.pem"
  fi
  [ -f "$G/truststore/tmrkz-local-directory-ca.pem" ] || cp "$G/certs/ca.crt" "$G/truststore/tmrkz-local-directory-ca.pem"
  # the users container only: no person is created here
  [ -f "$G/ldap/50-people-container.ldif" ] || \
    printf 'dn: ou=people,dc=tmrkz,dc=local\nobjectClass: organizationalUnit\nou: people\n' > "$G/ldap/50-people-container.ldif"
  [ -n "$(value LOCAL_LDAP_ADMIN_PASSWORD)" ] || setenv LOCAL_LDAP_ADMIN_PASSWORD "$(cat "$G/ldap-admin-password")"
  if [ -z "$LDAP" ]; then
    setenv LDAP_URL ldap://openldap:389; setenv LDAP_START_TLS true; setenv LDAP_BIND_DN cn=admin,dc=tmrkz,dc=local
    setenv LDAP_BIND_CREDENTIAL "$(value LOCAL_LDAP_ADMIN_PASSWORD)"; setenv LDAP_USERS_DN ou=people,dc=tmrkz,dc=local
  fi
  [ -n "$(value TMRKZ_TRUSTSTORE_DIR)" ] || setenv TMRKZ_TRUSTSTORE_DIR ./ops/local/.generated/truststore
fi
# data kept by an older version of this installation stays in Docker volumes until it is moved here (RUN.md section 6)
if [ -z "$(ls -A data/db 2>/dev/null)" ] && docker volume inspect tmrkz-mover_db-data >/dev/null 2>&1; then
  echo "  note: data/db is empty, and an older TMRKZ database is in the Docker volume tmrkz-mover_db-data — RUN.md section 6"
fi

# 1. the address
IP="${TMRKZ_IP:-}"; PORT="${TMRKZ_PORT:-}"
CUR_IP="$(value TMRKZ_IP)"; CUR_IP="${CUR_IP:-127.0.0.1}"; CUR_PORT="$(value TMRKZ_PORT)"; CUR_PORT="${CUR_PORT:-8088}"
if [ -z "$IP" ] || [ -z "$PORT" ]; then
  echo
  echo "  TMRKZ — the address people will open"
  echo "  IP addresses of this machine: $(addresses)(127.0.0.1: this machine only)"
fi
n=0
until echo "$IP" | grep -Eq '^(localhost|[0-9]+(\.[0-9]+){3})$'; do
  n=$((n + 1)); [ $n -le 3 ] || { echo "no valid IP address"; exit 2; }
  printf '  IP address [%s]: ' "$CUR_IP"; read -r IP || true; IP="${IP:-$CUR_IP}"
done
n=0
until echo "$PORT" | grep -Eq '^[0-9]+$' && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; do
  n=$((n + 1)); [ $n -le 3 ] || { echo "no valid port"; exit 2; }
  printf '  Port [%s]: ' "$CUR_PORT"; read -r PORT || true; PORT="${PORT:-$CUR_PORT}"
done
busy="$(docker ps --format '{{.Names}} {{.Ports}}' | grep -v '^tmrkz-mover-' | grep -E ":$PORT->" | cut -d' ' -f1 | head -n 1 || true)"
[ -z "$busy" ] || { echo "port $PORT is already used by the container $busy; choose another"; exit 2; }
setenv TMRKZ_IP "$IP"; setenv TMRKZ_PORT "$PORT"
# the same address for the tools of the image-built installation (ops/*.sh read these)
setenv TMRKZ_PUBLIC_URL "http://$IP:$PORT"; setenv MOVER_HTTP_PORT "$PORT"

# 2. the images: loaded when one is missing or tmrkz-images.tar is newer than the last one loaded here
LOADED=ops/local/.generated/images-loaded.sha256
mkdir -p ops/local/.generated data/db data/files data/ldap-data data/ldap-config
missing=0
for img in tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine; do
  docker image inspect "$img" >/dev/null 2>&1 || missing=1
done
if [ $missing = 1 ] || ! cmp -s tmrkz-images.tar.sha256 "$LOADED" 2>/dev/null; then
  [ -f tmrkz-images.tar ] || { echo "tmrkz-images.tar is not in this folder (make it on a connected machine: sh ops/local/workspace/pack-images.sh)"; exit 1; }
  echo "  checking tmrkz-images.tar …"
  (sha256sum -c tmrkz-images.tar.sha256 >/dev/null 2>&1 || shasum -a 256 -c tmrkz-images.tar.sha256 >/dev/null) || { echo "tmrkz-images.tar is damaged (checksum)"; exit 1; }
  echo "  docker load -i tmrkz-images.tar"; docker load -q -i tmrkz-images.tar >/dev/null && cp tmrkz-images.tar.sha256 "$LOADED"
fi

# 3. start (the first start builds the backend and the web from the source: a few minutes)
docker compose up -d
URL="http://$IP:$PORT"; LOCAL="http://127.0.0.1:$PORT"
echo "  waiting for TMRKZ (logs: docker compose logs -f backend web-build) …"
n=0
until [ "$(code "$LOCAL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] && [ "$(code "$LOCAL/api/v1/auth/status")" = 200 ]; do
  n=$((n + 1)); [ $n -le 300 ] || { echo "TMRKZ did not become ready — see: docker compose logs backend web-build"; exit 1; }; sleep 3
done
echo
echo "  TMRKZ is running: $URL"
echo "  sign in as admin or developer (passwords: TMRKZ_PLATFORM_ADMIN_PASSWORD / TMRKZ_PLATFORM_DEVELOPER_PASSWORD in .env)"
