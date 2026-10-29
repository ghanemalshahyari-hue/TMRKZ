#!/usr/bin/env sh
# Starts TMRKZ with the acceptance test environment (fictional directory, HR mirror and facilities).
# Generates, once, a test CA and server certificate for the directory, a directory admin password and one password
# shared by the fictional users, under ops/test-env/.generated/ (git-ignored). Never use this in production.
# Usage: sh ops/test-env/up.sh   (compose project tmrkz-test, own volumes; sign in at TMRKZ_PUBLIC_URL, default :8088)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
G=ops/test-env/.generated
mkdir -p "$G/certs" "$G/ldap"
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
[ -f "$G/ldap-admin-password" ] || rand 24 > "$G/ldap-admin-password"
[ -f "$G/user-password" ] || printf 'Test-%s' "$(rand 12)" > "$G/user-password"

if [ ! -f "$G/certs/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=TMRKZ Test CA" \
    -keyout "$G/certs/ca.key" -out "$G/certs/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=openldap" -keyout "$G/certs/ldap.key" -out "$G/certs/ldap.csr" 2>/dev/null
  printf 'subjectAltName=DNS:openldap\nextendedKeyUsage=serverAuth\n' > "$G/certs/ext.cnf"
  openssl x509 -req -in "$G/certs/ldap.csr" -CA "$G/certs/ca.crt" -CAkey "$G/certs/ca.key" -CAcreateserial -days 825 \
    -extfile "$G/certs/ext.cnf" -out "$G/certs/ldap.crt" 2>/dev/null
  rm -f "$G/certs/ldap.csr" "$G/certs/ext.cnf"
fi
# Keycloak trusts the test CA only (a separate folder, so the production truststore folder stays empty).
mkdir -p "$G/truststore" && cp "$G/certs/ca.crt" "$G/truststore/tmrkz-test-ca.pem"
sed "s/__PASSWORD__/$(cat "$G/user-password")/" ops/test-env/ldap/people.ldif > "$G/ldap/50-people.ldif"

sh ops/init-env.sh >/dev/null
export TEST_LDAP_ADMIN_PASSWORD="$(cat "$G/ldap-admin-password")"
export LDAP_URL="ldap://openldap:389"
export LDAP_START_TLS="true"
export LDAP_BIND_DN="cn=admin,dc=tmrkz,dc=test"
export LDAP_BIND_CREDENTIAL="$TEST_LDAP_ADMIN_PASSWORD"
export LDAP_USERS_DN="ou=people,dc=tmrkz,dc=test"
export TMRKZ_TRUSTSTORE_DIR="./$G/truststore"
docker compose -p tmrkz-test -f docker-compose.yml -f ops/test-env/compose.acceptance.yml up -d --build "$@"
echo "Test environment up. Fictional users and the shared password: ops/test-env/README.md and $G/user-password"
