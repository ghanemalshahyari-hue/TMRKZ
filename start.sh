#!/usr/bin/env sh
# TMRKZ on this machine, from this folder (owner, 19 Nov 2026). Asks for the address people will open — the IP address and
# the port — writes them into .env as TMRKZ_PUBLIC_URL=http://IP:PORT (the one address every sign-in address derives from,
# ADR-092), loads tmrkz-images.tar when its images are missing or newer, and starts everything. An https address set by
# ops/tls/enable.sh (TMRKZ_PUBLIC_URL=https://name) is kept: only the port is asked then.
# The same by hand:  set TMRKZ_IP and TMRKZ_PORT in .env,  docker load -i tmrkz-images.tar,  docker compose up -d
#   sh start.sh                                   asks
#   TMRKZ_IP=10.1.2.3 TMRKZ_PORT=8088 sh start.sh  does not ask
# On a new checkout it also creates .env (ops/init-env.sh) and the local directory's CA and password (ops/local/.generated).
# The enterprise directory and the enterprise Keycloak are entered after sign-in, in «إعدادات النظام ← إعدادات التكامل».
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
# data kept by an older version of this installation stays in Docker volumes until it is moved here (RUN.md section 7)
if [ -z "$(ls -A data/db 2>/dev/null)" ] && docker volume inspect tmrkz-mover_db-data >/dev/null 2>&1; then
  echo "  note: data/db is empty, and an older TMRKZ database is in the Docker volume tmrkz-mover_db-data — RUN.md section 7"
fi
# the containers were called tmrkz-mover-* until 23 Nov 2026 (ADR-098): they are replaced by tmrkz-*; the data in ./data is
# kept, and db-init renames the database on the first start (the old web volumes hold only built pages)
if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=tmrkz-mover 2>/dev/null)" ]; then
  echo "  replacing the containers of the old name tmrkz-mover (the data is kept)"
  docker compose -p tmrkz-mover down >/dev/null 2>&1 || true
  docker volume rm tmrkz-mover_web-html tmrkz-mover_web-docs >/dev/null 2>&1 || true
fi
# the same folder everywhere (RUN.md, «The folder»): anything else at the top is named, nothing is moved or deleted
extra="$(ls -A | grep -vxE '\.env|\.gitignore|\.gitattributes|\.github|\.vscode|\.zcode|\.git|AGENTS\.md|CLAUDE\.md|FINAL_HANDOFF_2026-11-18\.md|FONT-LICENSE\.txt|README\.md|RUN\.md|\.dockerignore|assets|backend|backups|certs|data|docker-compose\.yml|docker-compose\.override\.yml|docker-compose\.[A-Za-z0-9_-]+\.yml|docs|frontend|handoff|map-data|map-packages|map-runtime|ops|prototypes|release|start\.sh|tests|tmrkz-images\.tar|tmrkz-images\.tar\.sha256' | tr '\n' ' ' || true)"
[ -z "$extra" ] || echo "  note: not part of the TMRKZ folder — move to its place (RUN.md, «The folder»): $extra"

# 1. the address
IP="${TMRKZ_IP:-}"; PORT="${TMRKZ_PORT:-}"
CUR_IP="$(value TMRKZ_IP)"; CUR_IP="${CUR_IP:-127.0.0.1}"; CUR_PORT="$(value TMRKZ_PORT)"; CUR_PORT="${CUR_PORT:-8088}"
HTTPS="$(value TMRKZ_PUBLIC_URL)"; case "$HTTPS" in https://*) ;; *) HTTPS="";; esac
if [ -z "$IP" ] || [ -z "$PORT" ]; then
  echo
  echo "  TMRKZ — the address people will open"
  [ -n "$HTTPS" ] && echo "  https is on: people open $HTTPS (ops/tls); the IP address below is for the plain-http port only"
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
# another container on the port — this installation's own do not count (its project: COMPOSE_PROJECT_NAME or «name:», ADR-104)
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: //p' | head -n 1)"; PROJECT="${PROJECT:-tmrkz}"
own=" $(docker ps -q --filter label=com.docker.compose.project="$PROJECT" 2>/dev/null | tr '\n' ' ') "
busy="$(docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' | grep -E ":$PORT->" | awk -v own="$own" '$1 && index(own," "$1" ")==0{print $2;exit}' || true)"
[ -z "$busy" ] || { echo "port $PORT is already used by the container $busy; choose another"; exit 2; }
setenv TMRKZ_IP "$IP"; setenv TMRKZ_PORT "$PORT"
# the one address every sign-in address derives from (docker-compose.override.yml, ops/*.sh); an https address is kept
[ -n "$HTTPS" ] || setenv TMRKZ_PUBLIC_URL "http://$IP:$PORT"
setenv TMRKZ_HTTP_PORT "$PORT"

# 2. the images (ADR-104): an installation whose images are all loaded starts without tmrkz-images.tar or its checksum file.
#    The archive is loaded when an image is missing, or when an archive is present that differs from the last one loaded here.
LOADED=ops/local/.generated/images-loaded.sha256
mkdir -p ops/local/.generated data/db data/files data/ldap-data data/ldap-config
missing=""
for img in tmrkz/folder-backend:1 tmrkz/folder-web:1 postgis/postgis:17-3.5-alpine tmrkz/keycloak:26.7.5-2 openfga/openfga:v1.8.16 osixia/openldap:1.5.0 nginx:1.28.3-alpine; do
  docker image inspect "$img" >/dev/null 2>&1 || missing="$missing $img"
done
load_images() {
  [ -f tmrkz-images.tar.sha256 ] || { echo "tmrkz-images.tar.sha256 is missing: the archive is not loaded without its checksum"; exit 1; }
  echo "  checking tmrkz-images.tar …"
  (sha256sum -c tmrkz-images.tar.sha256 >/dev/null 2>&1 || shasum -a 256 -c tmrkz-images.tar.sha256 >/dev/null) || { echo "tmrkz-images.tar is damaged (checksum)"; exit 1; }
  echo "  docker load -i tmrkz-images.tar"; docker load -q -i tmrkz-images.tar >/dev/null && cp tmrkz-images.tar.sha256 "$LOADED"
}
if [ -n "$missing" ]; then
  [ -f tmrkz-images.tar ] || { echo "images not loaded on this machine:$missing"; echo "bring tmrkz-images.tar and tmrkz-images.tar.sha256 (made on a connected machine: sh ops/local/workspace/pack-images.sh)"; exit 1; }
  load_images
elif [ -f tmrkz-images.tar ] && [ -f tmrkz-images.tar.sha256 ] && ! cmp -s tmrkz-images.tar.sha256 "$LOADED" 2>/dev/null; then
  load_images
else
  echo "  images already loaded (tmrkz-images.tar not needed)"
fi

# 3. the Compose files (ADR-104): plain «docker compose» reads only docker-compose.yml and docker-compose.override.yml. Another
#    docker-compose.*.yml here (the VM's docker-compose.dc-hosts.yml) is used only when .env names it in COMPOSE_FILE; it is never
#    silently left out — starting without it would recreate the containers without its settings.
CF="$(value COMPOSE_FILE | tr ';' ':')"
running="$(docker ps -a --filter label=com.docker.compose.project="$PROJECT" --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | head -n 1)"
for f in $(ls docker-compose.*.yml 2>/dev/null | grep -vx 'docker-compose.override.yml'); do
  case ":$CF:" in *":$f:"*|*"/$f:"*|*"\\$f:"*) continue ;; esac
  echo "  $f is in this folder, but .env does not name it in COMPOSE_FILE: docker compose would leave it out."
  echo "  add these two lines to .env, then run start.sh again:"
  echo "    COMPOSE_PATH_SEPARATOR=:"
  echo "    COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:$f"
  [ -n "$running" ] && echo "  (the containers now running were started with: $running)"
  exit 2
done
[ -z "$CF" ] || echo "  Compose files (COMPOSE_FILE): $CF"

# 4. start (the first start builds the backend and the web from the source: a few minutes)
docker compose up -d
URL="${HTTPS:-http://$IP:$PORT}"; LOCAL="http://127.0.0.1:$PORT"
echo "  waiting for TMRKZ (logs: docker compose logs -f backend web-build) …"
n=0
until [ "$(code "$LOCAL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] && [ "$(code "$LOCAL/api/v1/auth/status")" = 200 ]; do
  n=$((n + 1)); [ $n -le 300 ] || { echo "TMRKZ did not become ready — see: docker compose logs backend web-build"; exit 1; }; sleep 3
done
# the platform accounts and their sign-in client are set by the one-time job keycloak-setup after Keycloak answers: a sign-in
# before it has finished is refused by the identity provider («رفض مزود الهوية إتمام الدخول»), so wait for it (ADR-104)
setup_done() {
  KS="$(docker compose ps -a -q keycloak-setup 2>/dev/null | head -n 1)"
  n=0
  while [ -n "$KS" ] && [ "$(docker inspect -f '{{.State.Status}}' "$KS" 2>/dev/null)" != exited ] && [ $n -lt 100 ]; do
    n=$((n + 1)); sleep 3
  done
  [ -z "$KS" ] || [ "$(docker inspect -f '{{.State.ExitCode}}' "$KS" 2>/dev/null)" = 0 ]
}
# a Keycloak that has only just started may answer one call with «unknown_error»; the job is safe to run again (it is run on
# every start), so it is run once more before reporting
if ! setup_done; then
  echo "  keycloak-setup did not finish; running it once more"
  docker compose up -d keycloak-setup >/dev/null 2>&1
  setup_done || echo "  note: keycloak-setup did not finish cleanly — see: docker compose logs keycloak-setup"
fi
echo
echo "  TMRKZ is running: $URL"
echo "  sign in as admin or developer (passwords: TMRKZ_PLATFORM_ADMIN_PASSWORD / TMRKZ_PLATFORM_DEVELOPER_PASSWORD in .env)"
echo "  the enterprise directory and Keycloak: إعدادات النظام ← إعدادات التكامل (RUN.md section 8)"
