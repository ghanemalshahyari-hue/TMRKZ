#!/usr/bin/env sh
# Step 3 of https (ADR-051): switches this installation to https once ops/tls/install-cert.sh has installed server.crt.
#
#   sh ops/tls/enable.sh [compose-project] [https-port]        (defaults: tmrkz, 443)
#
# Sets in .env, keeping a copy as .env.before-https-<time>:
#   TMRKZ_PUBLIC_URL=https://<certificate name>[:port]   TMRKZ_SECURE_COOKIE=true   COMPOSE_PROFILES=tls
#   TMRKZ_HTTP_BIND=127.0.0.1 (plain http from this host only)   TMRKZ_HTTPS_PORT=<port>
# then the new address in the identity provider (ops/keycloak/set-public-url.sh). Restart the stack afterwards:
#   production: docker compose -p <project> up -d        this folder: sh start.sh
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz}"
PORT="${2:-443}"
DIR="${TMRKZ_TLS_DIR:-ops/tls/private}"
# a path every tool here can open: on Windows the native openssl and curl need C:/..., not /tmp/...
native() { if [ -d "$1" ]; then (cd "$1" && (pwd -W 2>/dev/null || pwd)); else printf '%s/%s' "$(cd "$(dirname "$1")" && (pwd -W 2>/dev/null || pwd))" "$(basename "$1")"; fi; }
[ -f "$DIR/server.crt" ] && [ -f "$DIR/server.key" ] || { echo "[tls] no server.crt in $DIR: run ops/tls/install-cert.sh first" >&2; exit 2; }
DIR="$(native "$DIR")"
key="$(openssl pkey -in "$DIR/server.key" -pubout -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
crt="$(openssl x509 -in "$DIR/server.crt" -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
[ "$key" = "$crt" ] || { echo "[tls] server.crt does not hold server.key" >&2; exit 1; }
openssl x509 -in "$DIR/server.crt" -noout -checkend 0 >/dev/null || { echo "[tls] server.crt has expired" >&2; exit 1; }
case "$PORT" in *[!0-9]*|'') echo "[tls] the port must be a number" >&2; exit 2;; esac
NAME="$(openssl req -in "$DIR/server.csr" -noout -subject | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p')"
[ -n "$NAME" ] || { echo "[tls] cannot read the name from $DIR/server.csr" >&2; exit 1; }
URL="https://$NAME"
[ "$PORT" = 443 ] || URL="$URL:$PORT"

cp .env ".env.before-https-$(date -u +%Y%m%dT%H%M%SZ)"
setenv() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
setenv TMRKZ_PUBLIC_URL "$URL"
setenv TMRKZ_SECURE_COOKIE true
setenv COMPOSE_PROFILES tls
setenv TMRKZ_HTTP_BIND 127.0.0.1
setenv TMRKZ_HTTPS_PORT "$PORT"
echo "[tls] .env: TMRKZ_PUBLIC_URL=$URL, TMRKZ_SECURE_COOKIE=true, COMPOSE_PROFILES=tls, TMRKZ_HTTP_BIND=127.0.0.1, TMRKZ_HTTPS_PORT=$PORT"
sh ops/keycloak/set-public-url.sh "$PROJECT"
echo "[tls] now restart the stack; users open $URL (the name must resolve in the organisation's DNS to this server)"
