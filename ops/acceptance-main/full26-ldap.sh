#!/usr/bin/env sh
# FULL END-TO-END ACCEPTANCE (owner, 16 Nov 2026: "Yes, on :8088" — ACCEPTANCE ONLY): 14 fictional sign-in accounts
# full26.u01 … full26.u14 in the local stand-in directory of the one installation (tmrkz-mover-openldap-1, ou=people).
# They have no HR record: an administrator adds each one in «إدارة الصلاحيات والوحدات» ← «إضافة مستخدم» ← «بدون ربط
# الموارد» with its User ID before its first sign-in, then grants its roles there (ADR-061, ADR-065).
# The one password of these accounts is generated once into ops/acceptance-main/.generated/full26-password (git-ignored)
# and never printed. Re-running adds what is missing and changes nothing else.
#   sh ops/acceptance-main/full26-ldap.sh            add the accounts
#   sh ops/acceptance-main/full26-ldap.sh --remove   take them away again
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
C=tmrkz-mover-openldap-1
G=ops/acceptance-main/.generated
mkdir -p "$G"
ADMIN_PW="$(cat ops/local/.generated/ldap-admin-password)"
BASE="ou=people,dc=tmrkz,dc=local"
if [ "${1:-}" = "--remove" ]; then
  for n in 01 02 03 04 05 06 07 08 09 10 11 12 13 14; do
    docker exec "$C" ldapdelete -x -ZZ -H ldap://localhost -D cn=admin,dc=tmrkz,dc=local -w "$ADMIN_PW" "uid=full26.u$n,$BASE" 2>/dev/null || true
  done
  echo "[full26] accounts removed"; exit 0
fi
if [ ! -f "$G/full26-password" ]; then
  umask 077
  head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 18 > "$G/full26-password"
fi
HASH="$(docker exec "$C" slappasswd -s "$(cat "$G/full26-password")")"
LDIF="$G/full26.ldif"
: > "$LDIF"
for n in 01 02 03 04 05 06 07 08 09 10 11 12 13 14; do
  cat >> "$LDIF" <<EOF
dn: uid=full26.u$n,$BASE
objectClass: inetOrgPerson
uid: full26.u$n
cn: مستخدم قبول $n
sn: قبول
displayName: مستخدم قبول $n
description: ACCEPTANCE ONLY — fictional account of the full end-to-end acceptance (16 Nov 2026)
userPassword: $HASH

EOF
done
docker cp "$LDIF" "$C:/tmp/full26.ldif" >/dev/null
docker exec "$C" ldapadd -c -x -ZZ -H ldap://localhost -D cn=admin,dc=tmrkz,dc=local -w "$ADMIN_PW" -f /tmp/full26.ldif >/dev/null 2>&1 || true
docker exec "$C" rm -f /tmp/full26.ldif
rm -f "$LDIF"
COUNT="$(docker exec "$C" ldapsearch -x -ZZ -H ldap://localhost -D cn=admin,dc=tmrkz,dc=local -w "$ADMIN_PW" -b "$BASE" '(uid=full26.*)' uid | grep -c '^uid:' || true)"
echo "[full26] $COUNT of 14 accounts present in $BASE (password in $G/full26-password)"
