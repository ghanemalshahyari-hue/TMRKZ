#!/usr/bin/env sh
# Points the identity provider's directory federation «enterprise-directory» at the directory named in .env (ADR-052). The
# realm took the directory settings once, at its first start (ops/keycloak/realm/tmrkz-realm.json); this replaces them.
# Keycloak's own tests run first, through its truststore (the organisation's CA in TMRKZ_TRUSTSTORE_DIR): the connection
# (TLS verified, never switched off) and the service account's bind. A failed test changes nothing.
#
#   sh ops/keycloak/set-directory.sh [compose-project]               tests only (exit 3 when they pass)
#   CONFIRM=yes sh ops/keycloak/set-directory.sh [compose-project]   tests, then applies
#
# .env: LDAP_URL (ldaps://host:636, or ldap://host:389 with LDAP_START_TLS=true), LDAP_BIND_DN, LDAP_BIND_CREDENTIAL,
# LDAP_USERS_DN; Active Directory: LDAP_VENDOR=ad, LDAP_USERNAME_ATTRIBUTE=sAMAccountName, LDAP_UUID_ATTRIBUTE=objectGUID,
# LDAP_USER_OBJECT_CLASSES=person, organizationalPerson, user; optional LDAP_EMPLOYEE_NUMBER_ATTRIBUTE, LDAP_RDN_ATTRIBUTE.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz-mover}"
# a value from the environment wins over .env (as docker compose does)
value() { eval "v=\${$1:-}"; if [ -n "$v" ]; then printf '%s' "$v"; else sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r'; fi; }
URL="$(value LDAP_URL)"
START_TLS="$(value LDAP_START_TLS)"; START_TLS="${START_TLS:-true}"
BIND_DN="$(value LDAP_BIND_DN)"
BIND_PW="$(value LDAP_BIND_CREDENTIAL)"
USERS_DN="$(value LDAP_USERS_DN)"
VENDOR="$(value LDAP_VENDOR)"; VENDOR="${VENDOR:-other}"
USER_ATTR="$(value LDAP_USERNAME_ATTRIBUTE)"; USER_ATTR="${USER_ATTR:-uid}"
UUID_ATTR="$(value LDAP_UUID_ATTRIBUTE)"; UUID_ATTR="${UUID_ATTR:-entryUUID}"
CLASSES="$(value LDAP_USER_OBJECT_CLASSES)"; CLASSES="${CLASSES:-inetOrgPerson}"
EMP_ATTR="$(value LDAP_EMPLOYEE_NUMBER_ATTRIBUTE)"; EMP_ATTR="${EMP_ATTR:-employeeNumber}"
RDN_ATTR="$(value LDAP_RDN_ATTRIBUTE)"; [ -n "$RDN_ATTR" ] || { [ "$VENDOR" = ad ] && RDN_ATTR=cn || RDN_ATTR="$USER_ATTR"; }
KC_ADMIN="$(value TMRKZ_KEYCLOAK_ADMIN_PASSWORD)"

case "$URL" in ldaps://*|ldap://*) ;; *) echo "[directory] LDAP_URL must start with ldaps:// or ldap://" >&2; exit 2;; esac
# the stand-in only for a rehearsal of the tests (ALLOW_STANDIN=yes), never applied
case "$URL" in ldap://openldap*)
  [ "${ALLOW_STANDIN:-no}" = yes ] && [ "${CONFIRM:-no}" != yes ] || { echo "[directory] LDAP_URL still names the local stand-in directory" >&2; exit 2; };;
esac
case "$URL" in ldap://*) [ "$START_TLS" = true ] || { echo "[directory] ldap:// needs LDAP_START_TLS=true (no unencrypted bind)" >&2; exit 2; };; esac
case "$URL" in ldaps://*) START_TLS=false;; esac
for v in BIND_DN BIND_PW USERS_DN KC_ADMIN; do eval "[ -n \"\$$v\" ]" || { echo "[directory] $v is empty in .env" >&2; exit 2; }; done
case "$URL$BIND_DN$BIND_PW$USERS_DN$USER_ATTR$UUID_ATTR$CLASSES$EMP_ATTR$RDN_ATTR$KC_ADMIN" in
  *\'*|*\"*) echo "[directory] a value contains a quote; it cannot be passed safely" >&2; exit 2;;
esac

echo "[directory] testing $URL (StartTLS: $START_TLS) as $BIND_DN, users under $USERS_DN"
# The script and its secrets travel on stdin, never on a command line.
set +e
docker compose -p "$PROJECT" exec -T keycloak bash -s <<EOF
set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-dir.config"
trap 'rm -f /tmp/kcadm-dir.config' EXIT
\$K config credentials \$C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '$KC_ADMIN' >/dev/null
id="\$(\$K get components -r tmrkz -q name=enterprise-directory -q type=org.keycloak.storage.UserStorageProvider --fields id --format csv --noquotes \$C)"
[ -n "\$id" ] || { echo "[directory] federation enterprise-directory not found in realm tmrkz"; exit 4; }
test_ldap() {
  \$K create testLDAPConnection -r tmrkz \$C -s action="\$1" -s 'connectionUrl=$URL' -s startTls=$START_TLS -s useTruststoreSpi=always \
    -s connectionTimeout=5000 -s authType=simple -s 'bindDn=$BIND_DN' -s 'bindCredential=$BIND_PW' 2>&1
}
out="\$(test_ldap testConnection)" || { echo "[directory] FAIL connection (address, port, firewall or the directory's certificate): \$out"; exit 5; }
echo "[directory] PASS connection, the directory's certificate trusted"
out="\$(test_ldap testAuthentication)" || { echo "[directory] FAIL bind as the service account (name or password): \$out"; exit 6; }
echo "[directory] PASS bind as the service account"
[ "${CONFIRM:-no}" = yes ] || { echo "[directory] tests passed; nothing changed. Apply with CONFIRM=yes"; exit 3; }
\$K update components/\$id -r tmrkz \$C \
  -s 'config.connectionUrl=["$URL"]' -s 'config.startTls=["$START_TLS"]' -s 'config.vendor=["$VENDOR"]' \
  -s 'config.bindDn=["$BIND_DN"]' -s 'config.bindCredential=["$BIND_PW"]' -s 'config.usersDn=["$USERS_DN"]' \
  -s 'config.usernameLDAPAttribute=["$USER_ATTR"]' -s 'config.rdnLDAPAttribute=["$RDN_ATTR"]' \
  -s 'config.uuidLDAPAttribute=["$UUID_ATTR"]' -s 'config.userObjectClasses=["$CLASSES"]'
for m in username "employee number"; do
  mid="\$(\$K get components -r tmrkz -q parent=\$id -q name="\$m" --fields id --format csv --noquotes \$C)"
  [ -n "\$mid" ] || continue
  attr='$USER_ATTR'; [ "\$m" = "employee number" ] && attr='$EMP_ATTR'
  \$K update components/\$mid -r tmrkz \$C -s "config.\"ldap.attribute\"=[\"\$attr\"]"
done
echo "[directory] enterprise-directory now uses $URL ($VENDOR; login $USER_ATTR, id $UUID_ATTR, employee number $EMP_ATTR)"
EOF
rc=$?
set -e
exit $rc
