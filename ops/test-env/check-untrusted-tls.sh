#!/usr/bin/env sh
# PA-07: a directory whose certificate does not chain to a trusted CA is refused (no fallback, no insecure retry).
# Restarts the test environment's Keycloak with an empty truststore, expects sign-in to fail, then restores the trust
# and expects it to succeed again. Test environment only.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
G=ops/test-env/.generated
[ -f "$G/user-password" ] || { echo "start the test environment first: sh ops/test-env/up.sh"; exit 2; }
export TEST_LDAP_ADMIN_PASSWORD="$(cat "$G/ldap-admin-password")"
export LDAP_URL="ldap://openldap:389" LDAP_START_TLS="true" LDAP_BIND_DN="cn=admin,dc=tmrkz,dc=test"
export LDAP_BIND_CREDENTIAL="$TEST_LDAP_ADMIN_PASSWORD" LDAP_USERS_DN="ou=people,dc=tmrkz,dc=test"
compose() { docker compose -p tmrkz-test -f docker-compose.yml -f ops/test-env/compose.directory.yml -f ops/test-env/compose.data.yml "$@"; }
ready() {
  i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "${MOVER_URL:-http://localhost:8088}/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ]; do
    i=$((i + 1)); [ $i -gt 60 ] && { echo "identity provider did not become ready"; exit 1; }; sleep 3
  done
}
mkdir -p "$G/empty-truststore"
status=0
TMRKZ_TRUSTSTORE_DIR="./$G/empty-truststore" compose up -d keycloak >/dev/null 2>&1
ready
node tests/acceptance/signin-check.mjs t.requester expect-failure || status=1
# The refusal must come from certificate validation of the directory, not from anything else.
if docker logs tmrkz-test-keycloak-1 2>&1 | grep -qiE "PKIX path building failed|unable to find valid certification path"; then
  echo "PASS  refusal caused by the untrusted directory certificate (PKIX validation)"
else
  echo "FAIL  no certificate-validation error recorded for the refused sign-in"; status=1
fi
TMRKZ_TRUSTSTORE_DIR="./$G/truststore" compose up -d keycloak >/dev/null 2>&1
ready
node tests/acceptance/signin-check.mjs t.requester expect-success || status=1
exit $status
