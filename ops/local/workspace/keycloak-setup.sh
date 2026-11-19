#!/bin/bash
# Once per `docker compose up` (service keycloak-setup of docker-compose.override.yml, owner 19 Nov 2026): what
# ops/keycloak/set-public-url.sh, ops/platform-accounts.sh and ops/keycloak/set-platform-password-client.sh do on an
# image-built installation, run inside the Keycloak image against the running Keycloak. Idempotent.
#  1. the client tmrkz-web returns to PUBLIC_URL (TMRKZ_IP and TMRKZ_PORT of .env) after sign-in and sign-out;
#  2. the two lasting platform accounts admin and developer (local Keycloak users with the realm role tmrkz-platform),
#     with the passwords of .env — never directory users;
#  3. the backend-only client for their manual sign-in (ADR-070): no browser flow, no service account.
set -euo pipefail
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-setup.config"
F=/tmp/tmrkz-platform-password-client.json
trap 'rm -f /tmp/kcadm-setup.config "$F"' EXIT
URL="${PUBLIC_URL%/}"
for i in $(seq 1 60); do
  $K config credentials $C --server http://keycloak:8080/auth --realm master --user tmrkz-bootstrap --password "$KC_ADMIN_PASSWORD" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "[keycloak-setup] Keycloak did not accept the bootstrap administrator"; exit 1; }
  sleep 5
done

# 1. the sign-in return address
id="$($K get clients -r tmrkz -q clientId=tmrkz-web --fields id --format csv --noquotes $C)"
[ -n "$id" ] || { echo "[keycloak-setup] client tmrkz-web not found in realm tmrkz"; exit 3; }
$K update clients/"$id" -r tmrkz $C -s "redirectUris=[\"$URL/api/v1/auth/oidc/callback\"]" \
  -s "attributes.\"post.logout.redirect.uris\"=$URL/##$URL/?signed-out=1"
# its secret follows .env too, so a database brought from another machine signs in without matching secrets
[ -n "${OIDC_CLIENT_SECRET:-}" ] && $K update clients/"$id" -r tmrkz $C -s "secret=$OIDC_CLIENT_SECRET"
echo "[keycloak-setup] sign-in returns to $URL"
# Keycloak's own credentials page, as in MOVER (owner, 19 Nov 2026); TMRKZ_KEYCLOAK_LOGIN_THEME=tmrkz brings back TMRKZ's look
$K update realms/tmrkz -s "loginTheme=${LOGIN_THEME:-keycloak.v2}" $C
echo "[keycloak-setup] sign-in page: ${LOGIN_THEME:-keycloak.v2}"

# 1b. the directory Keycloak federates is the one .env names: its bind password follows .env (a folder copied from another
#     machine brings that machine's directory password; the realm keeps the one of its first start otherwise)
if [ -n "${LDAP_URL:-}" ] && [ -n "${LDAP_BIND_CREDENTIAL:-}" ]; then
  for cid in $($K get components -r tmrkz -q providerId=ldap --fields id --format csv --noquotes $C); do
    url="$($K get components/"$cid" -r tmrkz $C | tr -d '\n ' | grep -o '"connectionUrl":\["[^"]*"' | sed 's/.*\["//; s/"$//')"
    if [ "$url" = "$LDAP_URL" ]; then
      $K update components/"$cid" -r tmrkz -s "config.bindCredential=[\"$LDAP_BIND_CREDENTIAL\"]" $C
      echo "[keycloak-setup] directory $url: bind password from .env"
    fi
  done
fi

# 2. the platform accounts
$K get roles/tmrkz-platform -r tmrkz $C >/dev/null 2>&1 || { echo "[keycloak-setup] the realm has no role tmrkz-platform"; exit 3; }
ensure() {
  local login="$1" pw="$2" first="$3" last="$4" row id link
  row="$($K get users -r tmrkz -q username="$login" -q exact=true --fields id,federationLink --format csv --noquotes $C)"
  id="${row%%,*}"; link="${row#*,}"; [ "$row" = "$id" ] && link=""
  if [ -n "$id" ] && [ -n "$link" ]; then echo "[keycloak-setup] refused: '$login' is a directory user"; exit 4; fi
  if [ -z "$id" ]; then
    echo "[keycloak-setup] $login: creating"
    $K create users -r tmrkz -s username="$login" -s enabled=true -s firstName="$first" -s lastName="$last" \
      -s email="$login@tmrkz.invalid" -s emailVerified=true $C >/dev/null
  else
    echo "[keycloak-setup] $login: enabling"
    $K update users/"$id" -r tmrkz -s enabled=true -s 'requiredActions=[]' $C
  fi
  echo "[keycloak-setup] $login: password"
  $K set-password -r tmrkz --username "$login" --new-password "$pw" $C
  echo "[keycloak-setup] $login: platform role"
  $K add-roles -r tmrkz --uusername "$login" --rolename tmrkz-platform $C
}
ensure admin "$ADMIN_PASSWORD" 'مدير' 'النظام'
ensure developer "$DEVELOPER_PASSWORD" 'مطوّر' 'النظام'
echo "[keycloak-setup] platform accounts ready: admin, developer"

# 3. the manual-sign-in client of the platform accounts
cat >"$F" <<JSON
{
  "clientId": "$PASSWORD_CLIENT_ID", "name": "TMRKZ manual platform accounts", "enabled": true, "protocol": "openid-connect",
  "publicClient": false, "clientAuthenticatorType": "client-secret", "secret": "$PASSWORD_CLIENT_SECRET",
  "standardFlowEnabled": false, "implicitFlowEnabled": false, "directAccessGrantsEnabled": true, "serviceAccountsEnabled": false,
  "consentRequired": false, "frontchannelLogout": false, "fullScopeAllowed": false, "redirectUris": [], "webOrigins": [],
  "attributes": { "use.refresh.tokens": "false", "post.logout.redirect.uris": "$URL/?signed-out=1" },
  "defaultClientScopes": ["basic", "profile"], "optionalClientScopes": [],
  "protocolMappers": [{ "name": "platform role", "protocol": "openid-connect", "protocolMapper": "oidc-usermodel-realm-role-mapper",
    "config": { "claim.name": "tmrkz_roles", "multivalued": "true", "jsonType.label": "String", "id.token.claim": "true",
      "access.token.claim": "false", "userinfo.token.claim": "false" } }]
}
JSON
row="$($K get clients -r tmrkz -q clientId="$PASSWORD_CLIENT_ID" --fields id --format csv --noquotes $C)"
if [ -z "${row%%,*}" ]; then $K create clients -r tmrkz -f "$F" $C >/dev/null; else $K update clients/"${row%%,*}" -r tmrkz -f "$F" $C; fi
id="$($K get clients -r tmrkz -q clientId="$PASSWORD_CLIENT_ID" --fields id --format csv --noquotes $C)"; id="${id%%,*}"
role="$($K get roles/tmrkz-platform -r tmrkz --fields id,name --format csv --noquotes $C)"
if ! $K get clients/"$id"/scope-mappings/realm -r tmrkz $C | grep -q 'tmrkz-platform'; then
  $K create clients/"$id"/scope-mappings/realm -r tmrkz -b "[{\"id\":\"${role%%,*}\",\"name\":\"tmrkz-platform\"}]" $C >/dev/null
fi
echo "[keycloak-setup] manual platform password client ready: $PASSWORD_CLIENT_ID"
