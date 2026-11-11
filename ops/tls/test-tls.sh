#!/usr/bin/env sh
# Rehearses the https steps (ADR-051) with a throw-away test CA in a temporary directory; never touches ops/tls/private, .env
# or the identity provider. With a running stack it also starts the https entry point (the web image, ops/tls/proxy.conf.template)
# on 127.0.0.1:9443/9080 next to that stack's web service and checks TLS, the redirect and HSTS, then removes it.
#   sh ops/tls/test-tls.sh [compose-project]        (default tmrkz-mover; the proxy part is skipped if it is not running)
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
PROJECT="${1:-tmrkz-mover}"
NAME=tmrkz.rehearsal.invalid
# a fresh temporary directory, removed afterwards only when it is one mktemp made
TMPD="$(mktemp -d 2>/dev/null || true)"
case "$TMPD" in */tmp.?*) [ -d "$TMPD" ] ;; *) false ;; esac || { echo "[tls-test] cannot make a temporary directory" >&2; exit 1; }
T="$(cd "$TMPD" && (pwd -W 2>/dev/null || pwd))"
P="$T/priv"
fails=0
ok() { if [ "$1" = 0 ]; then echo "PASS $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
cleanup() { docker rm -f tmrkz-tls-rehearsal >/dev/null 2>&1; rm -rf -- "$TMPD"; }
trap cleanup EXIT

# --- step 1: key and request
TMRKZ_TLS_DIR="$P" sh ops/tls/make-csr.sh tmrkz >/dev/null 2>&1; [ $? = 2 ]; ok $? "a short name is refused"
TMRKZ_TLS_DIR="$P" sh ops/tls/make-csr.sh "$NAME" 10.0.0.5 >/dev/null 2>&1; ok $? "key and request made"
openssl req -in "$P/server.csr" -noout -text | grep -q "DNS:$NAME, IP Address:10.0.0.5"; ok $? "the request names DNS and IP"
TMRKZ_TLS_DIR="$P" sh ops/tls/make-csr.sh "$NAME" >/dev/null 2>&1; [ $? = 3 ]; ok $? "an existing key is never replaced"

# --- a test CA: root and issuing CA, as an AD CS hierarchy
C="$T/ca"; mkdir -p "$C"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Rehearsal Root CA" -keyout "$C/root.key" -out "$C/root.pem" \
  -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=Rehearsal Issuing CA" -keyout "$C/inter.key" -out "$C/inter.csr" 2>/dev/null
printf 'basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$C/inter.ext"
openssl x509 -req -in "$C/inter.csr" -CA "$C/root.pem" -CAkey "$C/root.key" -CAcreateserial -days 30 -extfile "$C/inter.ext" -out "$C/inter.pem" 2>/dev/null
sign() { # $1 csr  $2 san  $3 out
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$2" > "$C/leaf.ext"
  openssl x509 -req -in "$1" -CA "$C/inter.pem" -CAkey "$C/inter.key" -CAcreateserial -days 20 -extfile "$C/leaf.ext" -out "$3" 2>/dev/null
}
sign "$P/server.csr" "DNS:$NAME,IP:10.0.0.5" "$C/leaf.pem"
openssl x509 -in "$C/leaf.pem" -outform DER -out "$C/leaf.cer"
cat "$C/inter.pem" "$C/root.pem" > "$C/chain.pem"
openssl crl2pkcs7 -nocrl -certfile "$C/chain.pem" -out "$C/chain.p7b"

# --- step 2: refusals first (nothing installed), then the real one from DER + PKCS#7
openssl req -newkey rsa:2048 -nodes -subj "/CN=$NAME" -keyout "$T/other.key" -out "$T/other.csr" 2>/dev/null
sign "$T/other.csr" "DNS:$NAME,IP:10.0.0.5" "$T/other.pem"
TMRKZ_TLS_DIR="$P" sh ops/tls/install-cert.sh "$T/other.pem" "$C/chain.pem" >/dev/null 2>&1; [ $? = 1 ] && [ ! -f "$P/server.crt" ]; ok $? "a certificate for another key is refused"
sign "$P/server.csr" "DNS:$NAME" "$T/noip.pem"
TMRKZ_TLS_DIR="$P" sh ops/tls/install-cert.sh "$T/noip.pem" "$C/chain.pem" >/dev/null 2>&1; [ $? = 1 ] && [ ! -f "$P/server.crt" ]; ok $? "a certificate missing a requested name is refused"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Foreign Root" -keyout "$T/f.key" -out "$T/foreign.pem" 2>/dev/null
TMRKZ_TLS_DIR="$P" sh ops/tls/install-cert.sh "$C/leaf.pem" "$T/foreign.pem" >/dev/null 2>&1; [ $? = 1 ] && [ ! -f "$P/server.crt" ]; ok $? "a certificate from another CA is refused"
TMRKZ_TLS_DIR="$P" sh ops/tls/install-cert.sh "$C/leaf.cer" "$C/chain.p7b" > "$T/install.log" 2>&1; ok $? "the issued certificate (DER) and chain (PKCS#7) are installed"
[ "$(grep -c 'BEGIN CERTIFICATE' "$P/server.crt")" = 2 ]; ok $? "server.crt holds the certificate and the issuing CA, not the root"

# --- step 3 rehearsed: the https entry point next to the running stack
NET="$(docker network ls --format '{{.Name}}' | grep -x "${PROJECT}_internal" || true)"
if [ -z "$NET" ] || [ -z "$(docker compose -p "$PROJECT" ps -q web 2>/dev/null)" ]; then
  echo "SKIP the https entry point: $PROJECT is not running"
else
  HOST_T="$(cd "$T" && pwd -W 2>/dev/null || pwd)"
  HOST_R="$(pwd -W 2>/dev/null || pwd)"
  docker run -d --name tmrkz-tls-rehearsal --network "$NET" -e TMRKZ_HTTPS_PORT=9443 -p 127.0.0.1:9443:8443 -p 127.0.0.1:9080:8080 \
    -v "$HOST_R/ops/tls/proxy.conf.template:/etc/nginx/templates/default.conf.template:ro" -v "$HOST_T/priv:/etc/tmrkz-tls:ro" \
    mover/web:1.0.0 >/dev/null
  # trust and protocol are checked with OpenSSL (curl may use the platform's TLS stack and its revocation rules); HTTP with curl
  tls() { openssl s_client -connect 127.0.0.1:9443 -servername "$NAME" "$@" </dev/null 2>&1; }
  i=0; until tls -brief | grep -q 'Protocol version' || [ $i -ge 20 ]; do i=$((i + 1)); sleep 1; done
  tls -CAfile "$C/root.pem" -verify_return_error -verify_hostname "$NAME" | grep -q 'Verify return code: 0 (ok)'; ok $? "the certificate chains to the organisation's CA and names this host"
  tls -CAfile "$T/foreign.pem" -verify_return_error | grep -q 'Verify return code: 0 (ok)'; [ $? != 0 ]; ok $? "untrusted for anyone without the organisation's CA (no silent acceptance)"
  tls -tls1_1 | grep -q 'Protocol  *: TLSv1.1'; [ $? != 0 ]; ok $? "TLS 1.1 refused"
  tls -tls1_3 | grep -q 'TLSv1.3'; ok $? "TLS 1.3 offered"
  R="-k --resolve $NAME:9443:127.0.0.1"
  [ "$(curl -s -o /dev/null -w '%{http_code}' $R "https://$NAME:9443/")" = 200 ]; ok $? "https serves the application"
  [ "$(curl -s -o /dev/null -w '%{http_code}' $R "https://$NAME:9443/api/v1/auth/status")" = 200 ]; ok $? "https reaches the backend"
  [ "$(curl -s -o /dev/null -w '%{http_code}' $R "https://$NAME:9443/auth/realms/tmrkz/.well-known/openid-configuration")" = 200 ]; ok $? "https reaches the identity provider"
  curl -s -D - -o /dev/null $R "https://$NAME:9443/" | grep -qi '^strict-transport-security: max-age=31536000'; ok $? "HSTS sent"
  loc="$(curl -s -D - -o /dev/null -H "Host: $NAME" "http://127.0.0.1:9080/x?y=1" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
  [ "$loc" = "https://$NAME:9443/x?y=1" ]; ok $? "plain http redirects to https ($loc)"
fi
echo "[tls-test] $fails failure(s)"
exit $fails
