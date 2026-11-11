#!/usr/bin/env sh
# Step 2 of https (ADR-051): installs the certificate the PKI team issued for server.csr, only after checking it.
#
#   sh ops/tls/install-cert.sh <issued certificate> <CA chain>
#
# Either file may be PEM or DER (.cer/.crt) or PKCS#7 (.p7b). The CA chain holds the issuing CA and the root.
# Checks: the certificate holds this host's key (server.key), is valid now, is for server authentication, carries every
# name of the request, and chains to the given root. Then writes server.crt (certificate + issuing CAs) and ca-chain.pem
# next to server.key. Nothing is changed when a check fails.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
[ $# -eq 2 ] || { echo "usage: sh ops/tls/install-cert.sh <issued certificate> <CA chain>" >&2; exit 2; }
DIR="${TMRKZ_TLS_DIR:-ops/tls/private}"
[ -f "$DIR/server.key" ] && [ -f "$DIR/server.csr" ] || { echo "[tls] no server.key/server.csr in $DIR: run ops/tls/make-csr.sh first" >&2; exit 2; }
# a path every tool here can open: on Windows the native openssl and curl need C:/..., not /tmp/...
native() { if [ -d "$1" ]; then (cd "$1" && (pwd -W 2>/dev/null || pwd)); else printf '%s/%s' "$(cd "$(dirname "$1")" && (pwd -W 2>/dev/null || pwd))" "$(basename "$1")"; fi; }
DIR="$(native "$DIR")"
IN_CERT="$(native "$1")"
IN_CHAIN="$(native "$2")"
# a fresh temporary directory, removed afterwards only when it is one mktemp made
TMPD="$(mktemp -d 2>/dev/null || true)"
case "$TMPD" in */tmp.?*) [ -d "$TMPD" ] ;; *) false ;; esac || { echo "[tls] cannot make a temporary directory" >&2; exit 1; }
trap 'rm -rf -- "$TMPD"' EXIT
W="$(native "$TMPD")"

# every certificate of a file, as PEM blocks
to_pem() {
  if grep -q -- '-----BEGIN PKCS7-----' "$1" 2>/dev/null; then
    openssl pkcs7 -in "$1" -print_certs
  elif grep -q -- '-----BEGIN CERTIFICATE-----' "$1" 2>/dev/null; then
    cat "$1"
  elif openssl pkcs7 -inform DER -in "$1" -print_certs 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then
    openssl pkcs7 -inform DER -in "$1" -print_certs
  else
    openssl x509 -inform DER -in "$1"
  fi
}
# split a PEM bundle into one file per certificate: $2/cert-N.pem
split() {
  awk -v d="$2" '/-----BEGIN CERTIFICATE-----/{n++; f=sprintf("%s/cert-%02d.pem", d, n)} f{print > f} /-----END CERTIFICATE-----/{f=""}' "$1"
}
pub() { openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1; }

mkdir -p "$W/issued" "$W/chain"
to_pem "$IN_CERT" > "$W/issued.pem" || { echo "[tls] cannot read $1 as a certificate" >&2; exit 1; }
to_pem "$IN_CHAIN" > "$W/chain.pem" || { echo "[tls] cannot read $2 as a certificate chain" >&2; exit 1; }
split "$W/issued.pem" "$W/issued"
split "$W/chain.pem" "$W/chain"
KEY_PUB="$(openssl pkey -in "$DIR/server.key" -pubout -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"

# the leaf is the certificate holding this host's key (a .p7b from the CA may carry the chain too)
LEAF=""
for c in "$W"/issued/cert-*.pem; do
  if [ "$(pub "$c")" = "$KEY_PUB" ]; then LEAF="$c"; else cp "$c" "$W/chain/extra-$(basename "$c")"; fi
done
[ -n "$LEAF" ] || { echo "[tls] FAIL: the certificate does not hold this host's key (was it issued for $DIR/server.csr?)" >&2; exit 1; }
echo "[tls] PASS the certificate holds this host's key"

openssl x509 -in "$LEAF" -noout -checkend 0 >/dev/null || { echo "[tls] FAIL: the certificate has expired" >&2; exit 1; }
openssl x509 -in "$LEAF" -noout -ext extendedKeyUsage 2>/dev/null | grep -q 'TLS Web Server Authentication' \
  || { echo "[tls] FAIL: the certificate is not for server authentication (template «Web Server» expected)" >&2; exit 1; }
echo "[tls] PASS valid until $(openssl x509 -in "$LEAF" -noout -enddate | cut -d= -f2), for server authentication"

# the subjectAltName names of a request or certificate, one per line (DNS:x, IP:y), read from -text, which every OpenSSL prints
sans() { openssl "$1" -in "$2" -noout -text | awk '/X509v3 Subject Alternative Name/{getline; print; exit}' | tr ',' '\n' | sed 's/^ *//; s/IP Address/IP/' | grep -v '^$'; }
WANT="$(sans req "$DIR/server.csr")"
HAVE="$(sans x509 "$LEAF")"
[ -n "$WANT" ] || { echo "[tls] FAIL: the request has no names (subjectAltName)" >&2; exit 1; }
for n in $WANT; do
  echo "$HAVE" | grep -qxF "$n" || { echo "[tls] FAIL: the certificate lacks $n from the request" >&2; exit 1; }
done
echo "[tls] PASS every requested name: $(echo "$WANT" | tr '\n' ' ')"

# roots are self-signed; the others are issuing CAs
: > "$W/roots.pem"; : > "$W/inter.pem"
for c in "$W"/chain/*.pem; do
  [ -f "$c" ] || continue
  if [ "$(openssl x509 -in "$c" -noout -subject)" = "subject=$(openssl x509 -in "$c" -noout -issuer | cut -d= -f2-)" ]; then
    cat "$c" >> "$W/roots.pem"
  else
    cat "$c" >> "$W/inter.pem"
  fi
done
[ -s "$W/roots.pem" ] || { echo "[tls] FAIL: the CA chain has no root certificate" >&2; exit 1; }
set -- -CAfile "$W/roots.pem" -purpose sslserver
[ -s "$W/inter.pem" ] && set -- "$@" -untrusted "$W/inter.pem"
openssl verify "$@" "$LEAF" >/dev/null 2>"$W/verify.err" || { echo "[tls] FAIL: does not chain to the given CA: $(cat "$W/verify.err")" >&2; exit 1; }
echo "[tls] PASS chains to $(openssl x509 -in "$W/roots.pem" -noout -subject | cut -d= -f2-)"

# only the issuing CAs that lie on this certificate's path go after it (browsers have the root)
: > "$W/path.pem"
cur="$LEAF"
while :; do
  issuer="$(openssl x509 -in "$cur" -noout -issuer | cut -d= -f2-)"
  next=""
  for c in "$W"/chain/*.pem; do
    [ -f "$c" ] || continue
    [ "$(openssl x509 -in "$c" -noout -subject | cut -d= -f2-)" = "$issuer" ] && { next="$c"; break; }
  done
  [ -n "$next" ] || break
  [ "$(openssl x509 -in "$next" -noout -subject)" = "subject=$(openssl x509 -in "$next" -noout -issuer | cut -d= -f2-)" ] && break
  cat "$next" >> "$W/path.pem"
  cur="$next"
done
cat "$LEAF" "$W/path.pem" > "$DIR/server.crt"
cat "$W/inter.pem" "$W/roots.pem" > "$DIR/ca-chain.pem"
echo "[tls] installed $DIR/server.crt ($(grep -c 'BEGIN CERTIFICATE' "$DIR/server.crt") certificates) and $DIR/ca-chain.pem"
echo "  next: sh ops/tls/enable.sh   (sets https in .env and in the identity provider, then restart the stack)"
