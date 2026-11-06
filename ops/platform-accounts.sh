#!/usr/bin/env sh
# The two lasting platform accounts of an installation (owner decision of 6 Nov 2026; V21, ADR-037): «admin» (super
# administrator) and «developer». Each is a LOCAL Keycloak user of the tmrkz realm holding the realm role tmrkz-platform,
# never a directory user. Passwords come from the installation's .env (TMRKZ_PLATFORM_ADMIN_PASSWORD,
# TMRKZ_PLATFORM_DEVELOPER_PASSWORD; ops/init-env.sh generates random ones), never from this repository. Re-running sets
# the passwords to the .env values again. Refused when a directory user already holds either login.
# Their first TMRKZ sign-in creates the local person with lasting administrator and auditor grants.
# Usage: sh ops/platform-accounts.sh [compose-project]   (default tmrkz-mover; Keycloak must be healthy)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
PROJECT="${1:-tmrkz-mover}"
value() { sed -n "s/^$1=//p" .env | tail -n 1; }
KC_ADMIN="$(value TMRKZ_KEYCLOAK_ADMIN_PASSWORD)"
ADMIN_PW="$(value TMRKZ_PLATFORM_ADMIN_PASSWORD)"
DEV_PW="$(value TMRKZ_PLATFORM_DEVELOPER_PASSWORD)"
[ -n "$KC_ADMIN" ] || { echo "TMRKZ_KEYCLOAK_ADMIN_PASSWORD missing in .env (run ops/init-env.sh)"; exit 2; }
[ -n "$ADMIN_PW" ] && [ -n "$DEV_PW" ] || { echo "platform passwords missing in .env (run ops/init-env.sh)"; exit 2; }
case "$ADMIN_PW$DEV_PW" in *\'*) echo "a platform password contains a single quote; choose another"; exit 2;; esac

# The script and its secrets travel on stdin, never on a command line.
docker compose -p "$PROJECT" exec -T keycloak bash -s <<EOF
set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-platform.config"
trap 'rm -f /tmp/kcadm-platform.config' EXIT
\$K config credentials \$C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '$KC_ADMIN' >/dev/null
\$K get roles/tmrkz-platform -r tmrkz \$C >/dev/null 2>&1 || { echo "the tmrkz realm has no role tmrkz-platform (realm imported before V21)"; exit 3; }
ensure() {
  login="\$1"; pw="\$2"; first="\$3"; last="\$4"
  row="\$(\$K get users -r tmrkz -q username="\$login" -q exact=true --fields id,federationLink --format csv --noquotes \$C)"
  id="\${row%%,*}"; link="\${row#*,}"; [ "\$row" = "\$id" ] && link=""
  if [ -n "\$id" ] && [ -n "\$link" ]; then echo "refused: '\$login' is a directory user"; exit 4; fi
  if [ -z "\$id" ]; then
    \$K create users -r tmrkz -s username="\$login" -s enabled=true -s firstName="\$first" -s lastName="\$last" \
      -s email="\$login@tmrkz.invalid" -s emailVerified=true \$C >/dev/null
    echo "created \$login"
  else
    \$K update users/\$id -r tmrkz -s enabled=true -s 'requiredActions=[]' \$C
    echo "updated \$login"
  fi
  \$K set-password -r tmrkz --username "\$login" --new-password "\$pw" \$C
  \$K add-roles -r tmrkz --uusername "\$login" --rolename tmrkz-platform \$C
}
ensure admin '$ADMIN_PW' 'مدير' 'النظام'
ensure developer '$DEV_PW' 'مطوّر' 'النظام'
EOF
echo "platform accounts ready: admin, developer (sign in at $(value TMRKZ_PUBLIC_URL) with «الدخول الآلي بالحساب المؤسسي»)"
