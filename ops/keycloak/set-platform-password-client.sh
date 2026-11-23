#!/usr/bin/env sh
# Backend-only Keycloak client for manual sign-in of the allow-listed platform accounts (ADR-070).
# It has no browser authorization-code flow and no service account. The normal tmrkz-web client is unchanged.
# Usage: sh ops/keycloak/set-platform-password-client.sh [compose-project]  (default tmrkz)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz}"
value() { sed -n "s/^$1=//p" .env | tail -n 1; }
KC_ADMIN="$(value TMRKZ_KEYCLOAK_ADMIN_PASSWORD)"
CLIENT_ID="$(value TMRKZ_PLATFORM_OIDC_CLIENT_ID)"
CLIENT_SECRET="$(value TMRKZ_PLATFORM_OIDC_CLIENT_SECRET)"
PUBLIC_URL="$(value TMRKZ_PUBLIC_URL)"
CLIENT_ID="${CLIENT_ID:-tmrkz-platform-password}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:8088}"
[ -n "$KC_ADMIN" ] && [ -n "$CLIENT_SECRET" ] || { echo "run ops/init-env.sh to provision Keycloak secrets"; exit 2; }
case "$CLIENT_ID" in *[!A-Za-z0-9.-]*) echo "invalid TMRKZ_PLATFORM_OIDC_CLIENT_ID"; exit 2;; esac
case "$KC_ADMIN$CLIENT_SECRET" in *\'*) echo "a Keycloak secret contains a single quote; choose another"; exit 2;; esac

# Secrets travel on standard input, never on the command line. The managed client is replaced idempotently only.
docker compose -p "$PROJECT" exec -T keycloak bash -s <<EOF
set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-platform-password.config"
F=/tmp/tmrkz-platform-password-client.json
trap 'rm -f /tmp/kcadm-platform-password.config "\$F"' EXIT
\$K config credentials \$C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '$KC_ADMIN' >/dev/null
row="\$(\$K get clients -r tmrkz -q clientId='$CLIENT_ID' --fields id --format csv --noquotes \$C)"
id="\${row%%,*}"
cat >"\$F" <<JSON
{
  "clientId": "$CLIENT_ID",
  "name": "TMRKZ manual platform accounts",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CLIENT_SECRET",
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": true,
  "serviceAccountsEnabled": false,
  "consentRequired": false,
  "frontchannelLogout": false,
  "fullScopeAllowed": false,
  "redirectUris": [],
  "webOrigins": [],
  "attributes": {
    "use.refresh.tokens": "false",
    "post.logout.redirect.uris": "$PUBLIC_URL/?signed-out=1"
  },
  "defaultClientScopes": ["basic", "profile"],
  "optionalClientScopes": [],
  "protocolMappers": [{
    "name": "platform role",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-usermodel-realm-role-mapper",
    "config": {
      "claim.name": "tmrkz_roles",
      "multivalued": "true",
      "jsonType.label": "String",
      "id.token.claim": "true",
      "access.token.claim": "false",
      "userinfo.token.claim": "false"
    }
  }]
}
JSON
if [ -z "\$id" ]; then
  \$K create clients -r tmrkz -f "\$F" \$C >/dev/null
else
  \$K update clients/"\$id" -r tmrkz -f "\$F" \$C
fi
id="\$(\$K get clients -r tmrkz -q clientId='$CLIENT_ID' --fields id --format csv --noquotes \$C)"
id="\${id%%,*}"
# Only this realm role may enter this client's tmrkz_roles claim.
role="\$(\$K get roles/tmrkz-platform -r tmrkz --fields id,name --format csv --noquotes \$C)"
roleId="\${role%%,*}"
if ! \$K get clients/"\$id"/scope-mappings/realm -r tmrkz \$C | grep -q 'tmrkz-platform'; then
  \$K create clients/"\$id"/scope-mappings/realm -r tmrkz -b "[{\"id\":\"\$roleId\",\"name\":\"tmrkz-platform\"}]" \$C >/dev/null
fi
EOF
echo "manual platform password client ready: $CLIENT_ID"
