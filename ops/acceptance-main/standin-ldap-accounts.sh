#!/usr/bin/env sh
# ACCEPTANCE ONLY (release closure, 20 Nov 2026). Synthetic sign-in accounts for the browser acceptance on :8088, in the
# folder installation's OWN stand-in directory (openldap of docker-compose.override.yml, data/ldap-*): the logins of synthetic
# HR_AI people (TNQL's 100 % synthetic data), so they link to their HR record on first sign-in (DOMAIN_ACCOUNT). Nothing of
# this is in the transfer package: data/ stays on this machine. The password is generated once into a git-ignored file
# (the same file the acceptance scripts read) and travels on stdin only.
#   sh ops/acceptance-main/standin-ldap-accounts.sh add <login> <employee-number> <display name> [<login> <number> <name>…]
#   sh ops/acceptance-main/standin-ldap-accounts.sh remove <login>…
#   sh ops/acceptance-main/standin-ldap-accounts.sh list
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
A=ops/acceptance-main/.generated; mkdir -p "$A"
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
[ -f "$A/mover-ldap-test-password" ] || { umask 077; printf 'Tz9-%s' "$(rand 18)" > "$A/mover-ldap-test-password"; }
TPW="$(cat "$A/mover-ldap-test-password")"
ADMIN_PW="$(sed -n 's/^LOCAL_LDAP_ADMIN_PASSWORD=//p' .env | tail -n 1 | tr -d '\r' | tr -d "'\"")"
[ -n "$ADMIN_PW" ] || { echo "LOCAL_LDAP_ADMIN_PASSWORD is not in .env (sh start.sh writes it)" >&2; exit 2; }
BASE="ou=people,dc=tmrkz,dc=local"
ldap() { docker compose exec -T -e PW="$ADMIN_PW" openldap sh -c "$1"; }

case "${1:-list}" in
  list)
    ldap 'ldapsearch -x -LLL -H ldap://localhost:389 -D cn=admin,dc=tmrkz,dc=local -w "$PW" -b '"$BASE"' "(objectClass=inetOrgPerson)" uid employeeNumber displayName' ;;
  remove)
    shift
    for u in "$@"; do ldap 'ldapdelete -x -H ldap://localhost:389 -D cn=admin,dc=tmrkz,dc=local -w "$PW" "uid='"$u"','"$BASE"'"' && echo "removed $u"; done ;;
  add)
    shift
    while [ $# -ge 3 ]; do
      u="$1"; n="$2"; name="$3"; shift 3
      case "$u$n" in *[!A-Za-z0-9._-]*) echo "login and number: letters, digits, dot, hyphen, underscore only" >&2; exit 2;; esac
      if ldap 'ldapsearch -x -LLL -H ldap://localhost:389 -D cn=admin,dc=tmrkz,dc=local -w "$PW" -b '"$BASE"' "(uid='"$u"')" dn' | grep -q '^dn:'; then
        echo "$u: already in the stand-in directory; password set again"
      else
        printf 'dn: uid=%s,%s\nobjectClass: inetOrgPerson\nuid: %s\ncn: %s\nsn: %s\ndisplayName: %s\nemployeeNumber: %s\n' "$u" "$BASE" "$u" "$name" "${name##* }" "$name" "$n" \
          | ldap 'ldapadd -x -H ldap://localhost:389 -D cn=admin,dc=tmrkz,dc=local -w "$PW"' >/dev/null
        echo "$u: added ($n)"
      fi
      printf '%s' "$TPW" | ldap 'ldappasswd -x -H ldap://localhost:389 -D cn=admin,dc=tmrkz,dc=local -w "$PW" -T /dev/stdin "uid='"$u"','"$BASE"'"' >/dev/null
    done ;;
  *) echo "add|remove|list" >&2; exit 2 ;;
esac
