#!/usr/bin/env sh
# Points the identity provider's client tmrkz-web at TMRKZ_PUBLIC_URL (ADR-051). The realm took the address once, at its
# first start (ops/keycloak/realm/tmrkz-realm.json); after the address changes (to https, or a new name) this replaces the
# sign-in return address and the sign-out address. Keycloak itself reads TMRKZ_PUBLIC_URL again at its next start.
#   sh ops/keycloak/set-public-url.sh [compose-project]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz-mover}"
value() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r'; }
URL="$(value TMRKZ_PUBLIC_URL)"
URL="${URL%/}"
KC_ADMIN="$(value TMRKZ_KEYCLOAK_ADMIN_PASSWORD)"
case "$URL" in http://*|https://*) ;; *) echo "TMRKZ_PUBLIC_URL missing or not an http(s) address in .env" >&2; exit 2;; esac
[ -n "$KC_ADMIN" ] || { echo "TMRKZ_KEYCLOAK_ADMIN_PASSWORD missing in .env" >&2; exit 2; }
case "$KC_ADMIN$URL" in *\'*) echo "a value contains a single quote; choose another" >&2; exit 2;; esac

# The script and its secret travel on stdin, never on a command line.
docker compose -p "$PROJECT" exec -T keycloak bash -s <<EOF
set -eu
K=/opt/keycloak/bin/kcadm.sh
C="--config /tmp/kcadm-url.config"
trap 'rm -f /tmp/kcadm-url.config' EXIT
\$K config credentials \$C --server http://localhost:8080/auth --realm master --user tmrkz-bootstrap --password '$KC_ADMIN' >/dev/null
id="\$(\$K get clients -r tmrkz -q clientId=tmrkz-web --fields id --format csv --noquotes \$C)"
[ -n "\$id" ] || { echo "client tmrkz-web not found in realm tmrkz"; exit 3; }
\$K update clients/\$id -r tmrkz \$C -s 'redirectUris=["$URL/api/v1/auth/oidc/callback"]' \
  -s 'attributes."post.logout.redirect.uris"=$URL/##$URL/?signed-out=1'
echo "identity provider: tmrkz-web returns to $URL"
EOF
