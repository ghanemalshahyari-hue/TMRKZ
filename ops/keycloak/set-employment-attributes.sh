#!/usr/bin/env sh
# Makes the identity provider carry the employment attributes TMRKZ reads before Oracle is in force (ADR-068): unit ID, unit
# name, main unit ID, rank and position. For each one the .env names a directory attribute for (LDAP_ATTR_UNIT_ID,
# LDAP_ATTR_UNIT_NAME, LDAP_ATTR_MAIN_UNIT_ID, LDAP_ATTR_RANK, LDAP_ATTR_POSITION), the federation «enterprise-directory» gets a
# read-only attribute mapper (directory attribute -> user attribute tmrkz_*); an attribute left empty removes its mapper (not
# read). The client tmrkz-web gets the five ID-token claims tmrkz_unit_id, tmrkz_unit_name, tmrkz_main_unit_id, tmrkz_rank,
# tmrkz_position (already in the realm of a new installation; added here to a realm imported before ADR-068). Idempotent: run
# it again after any change. The realm took its settings once, at its first start (ops/keycloak/realm/tmrkz-realm.json), and an
# empty LDAP attribute name is refused by Keycloak, so the directory mappers are made here, not at import.
#
#   sh ops/keycloak/set-employment-attributes.sh [compose-project]               shows what would change; changes nothing
#   CONFIRM=yes sh ops/keycloak/set-employment-attributes.sh [compose-project]   applies
#
# Then set the matching claim names for TMRKZ in .env (TMRKZ_OIDC_CLAIM_UNIT_ID=tmrkz_unit_id, …; printed at the end) and
# restart the backend. No password is read or printed except the Keycloak administrator's, which travels on stdin only.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz-mover}"
# a value from the environment wins over .env (as docker compose does)
value() { eval "v=\${$1:-}"; if [ -n "$v" ]; then printf '%s' "$v"; else sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r'; fi; }
KC_ADMIN="$(value TMRKZ_KEYCLOAK_ADMIN_PASSWORD)"
[ -n "$KC_ADMIN" ] || { echo "[employment] TMRKZ_KEYCLOAK_ADMIN_PASSWORD is empty in .env" >&2; exit 2; }
case "$KC_ADMIN" in *\'*) echo "[employment] the Keycloak administrator password contains a single quote" >&2; exit 2;; esac

# mapper name | user attribute (= claim) | .env setting
MAPS="unit id|tmrkz_unit_id|LDAP_ATTR_UNIT_ID
unit name|tmrkz_unit_name|LDAP_ATTR_UNIT_NAME
main unit id|tmrkz_main_unit_id|LDAP_ATTR_MAIN_UNIT_ID
rank|tmrkz_rank|LDAP_ATTR_RANK
position|tmrkz_position|LDAP_ATTR_POSITION"
PLAN=""
NL='
'
while IFS='|' read -r name attr setting; do
  ldap="$(value "$setting")"
  if [ -n "$ldap" ]; then
    printf '%s' "$ldap" | grep -Eq '^[A-Za-z][A-Za-z0-9-]{0,63}$' || { echo "[employment] $setting is not a directory attribute name" >&2; exit 2; }
  fi
  PLAN="$PLAN$name|$attr|$ldap$NL"
done <<EOF_MAPS
$MAPS
EOF_MAPS

echo "[employment] directory attributes: $(printf '%s' "$PLAN" | awk -F'|' 'NF { printf "%s%s=%s", sep, $2, ($3 == "" ? "(not read)" : $3); sep = ", " }')"
# The script and the administrator password travel on stdin, never on a command line.
set +e
docker compose -p "$PROJECT" exec -T keycloak bash -s <<EOF
set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-emp.config"
trap 'rm -f /tmp/kcadm-emp.config' EXIT
\$K config credentials \$C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '$KC_ADMIN' >/dev/null
fed="\$(\$K get components -r tmrkz -q name=enterprise-directory -q type=org.keycloak.storage.UserStorageProvider --fields id --format csv --noquotes \$C)"
[ -n "\$fed" ] || { echo "[employment] federation enterprise-directory not found in realm tmrkz"; exit 4; }
cid="\$(\$K get clients -r tmrkz -q clientId=tmrkz-web --fields id --format csv --noquotes \$C)"
[ -n "\$cid" ] || { echo "[employment] client tmrkz-web not found in realm tmrkz"; exit 4; }
apply() { [ "${CONFIRM:-no}" = yes ]; }
claims="\$(\$K get clients/\$cid/protocol-mappers/models -r tmrkz --fields name --format csv --noquotes \$C)"
printf '%s' '$PLAN' | while IFS='|' read -r name attr ldap; do
  [ -n "\$name" ] || continue
  mid="\$(\$K get components -r tmrkz -q parent=\$fed -q name="\$name" --fields id --format csv --noquotes \$C)"
  if [ -z "\$ldap" ]; then
    if [ -n "\$mid" ]; then
      echo "[employment] directory mapper '\$name': remove (no attribute named)"
      if apply; then \$K delete components/\$mid -r tmrkz \$C; fi
    fi
  elif [ -n "\$mid" ]; then
    echo "[employment] directory mapper '\$name': \$ldap -> \$attr"
    if apply; then
      \$K update components/\$mid -r tmrkz \$C -s "config.\"ldap.attribute\"=[\"\$ldap\"]" \
        -s "config.\"user.model.attribute\"=[\"\$attr\"]" -s 'config."read.only"=["true"]' -s 'config."always.read.value.from.ldap"=["true"]'
    fi
  else
    echo "[employment] directory mapper '\$name': create \$ldap -> \$attr"
    if apply; then
      \$K create components -r tmrkz \$C -s name="\$name" -s providerId=user-attribute-ldap-mapper \
        -s providerType=org.keycloak.storage.ldap.mappers.LDAPStorageMapper -s parentId="\$fed" \
        -s "config.\"ldap.attribute\"=[\"\$ldap\"]" -s "config.\"user.model.attribute\"=[\"\$attr\"]" -s 'config."read.only"=["true"]' \
        -s 'config."always.read.value.from.ldap"=["true"]' -s 'config."is.mandatory.in.ldap"=["false"]' >/dev/null
    fi
  fi
  if ! printf '%s\n' "\$claims" | grep -qx "\$name"; then
    echo "[employment] ID-token claim \$attr: add to tmrkz-web"
    if apply; then
      \$K create clients/\$cid/protocol-mappers/models -r tmrkz \$C -s name="\$name" -s protocol=openid-connect \
        -s protocolMapper=oidc-usermodel-attribute-mapper -s "config.\"user.attribute\"=\$attr" -s "config.\"claim.name\"=\$attr" \
        -s 'config."jsonType.label"=String' -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=false' \
        -s 'config."userinfo.token.claim"=false' >/dev/null
    fi
  fi
done
apply || { echo "[employment] nothing changed. Apply with CONFIRM=yes"; exit 3; }
echo "[employment] applied"
EOF
rc=$?
set -e
[ "$rc" -eq 0 ] || exit $rc
echo "[employment] for TMRKZ's automatic sign-in set in .env, then restart the backend:"
printf '%s' "$PLAN" | awk -F'|' 'NF && $3 != "" {
  s = $2; sub(/^tmrkz_/, "", s); printf "  TMRKZ_OIDC_CLAIM_%s=%s\n", toupper(s), $2 }'
