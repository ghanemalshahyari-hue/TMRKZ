#!/usr/bin/env sh
# The single local TMRKZ installation (owner decision of 6 Nov 2026): the production project tmrkz-mover on
# TMRKZ_PUBLIC_URL (default http://localhost:8088), started empty, with no test data and no test accounts. Only the two
# lasting platform accounts exist (admin, developer; passwords in .env, see ops/platform-accounts.sh). Until the
# enterprise directory is configured, a local stand-in directory with no people is used (compose.local-directory.yml).
# Usage: sh ops/local/up.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
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
# the users container only: no person is created here
printf 'dn: ou=people,dc=tmrkz,dc=local\nobjectClass: organizationalUnit\nou: people\n' > "$G/ldap/50-people-container.ldif"

sh ops/init-env.sh >/dev/null
export LOCAL_LDAP_ADMIN_PASSWORD="$(cat "$G/ldap-admin-password")"
export LDAP_URL="ldap://openldap:389" LDAP_START_TLS="true" LDAP_BIND_DN="cn=admin,dc=tmrkz,dc=local"
export LDAP_BIND_CREDENTIAL="$LOCAL_LDAP_ADMIN_PASSWORD" LDAP_USERS_DN="ou=people,dc=tmrkz,dc=local"
export TMRKZ_TRUSTSTORE_DIR="./$G/truststore"
URL="$(sed -n 's/^TMRKZ_PUBLIC_URL=//p' .env | tail -n 1)"; URL="${URL:-http://localhost:8088}"

docker compose -p tmrkz-mover -f docker-compose.yml -f ops/local/compose.local-directory.yml up -d --build "$@"
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ] \
   && [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/auth/status")" = 200 ]; do
  i=$((i + 1)); [ $i -gt 120 ] && { echo "TMRKZ did not become ready at $URL"; exit 1; }; sleep 3
done
# right after its first start Keycloak may still refuse the administration login for a few seconds
i=0
until sh ops/platform-accounts.sh tmrkz-mover; do
  i=$((i + 1)); [ $i -ge 5 ] && { echo "platform accounts not created; re-run: sh ops/platform-accounts.sh tmrkz-mover"; exit 1; }; sleep 10
done
echo "TMRKZ is up at $URL — sign in as admin or developer (passwords: TMRKZ_PLATFORM_*_PASSWORD in .env)"
