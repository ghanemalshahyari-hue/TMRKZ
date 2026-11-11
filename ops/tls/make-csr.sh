#!/usr/bin/env sh
# Step 1 of https (owner, 11 Nov 2026; ADR-051): the private key and the certificate request (CSR) for the organisation's
# internal CA. The key is made on this host and never leaves it; only server.csr goes to the PKI team (template «Web Server»).
#
#   sh ops/tls/make-csr.sh <dns-name> [more dns names or IPv4 addresses...]
#
# The first name is the address users open (TMRKZ_PUBLIC_URL); every name is in the certificate's subjectAltName.
# Output in TMRKZ_TLS_DIR (default ops/tls/private, never committed): server.key and server.csr. An existing key is never
# replaced: to start again, move that directory aside yourself. TLS_KEY_BITS (default 2048) sets the RSA key size.
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
[ $# -ge 1 ] || { echo "usage: sh ops/tls/make-csr.sh <dns-name> [more dns names or IPv4 addresses]" >&2; exit 2; }
DIR="${TMRKZ_TLS_DIR:-ops/tls/private}"
BITS="${TLS_KEY_BITS:-2048}"
case "$BITS" in 2048|3072|4096) ;; *) echo "[tls] TLS_KEY_BITS must be 2048, 3072 or 4096" >&2; exit 2;; esac
# a path every tool here can open: on Windows the native openssl and curl need C:/..., not /tmp/...
native() { if [ -d "$1" ]; then (cd "$1" && (pwd -W 2>/dev/null || pwd)); else printf '%s/%s' "$(cd "$(dirname "$1")" && (pwd -W 2>/dev/null || pwd))" "$(basename "$1")"; fi; }
[ ! -e "$DIR/server.key" ] || { echo "[tls] $DIR/server.key already exists and is kept; move $DIR aside to make a new key" >&2; exit 3; }

san=""
for n in "$@"; do
  if printf '%s' "$n" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    kind=IP
  elif printf '%s' "$n" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'; then
    kind=DNS
  else
    echo "[tls] '$n' is not a full DNS name (like tmrkz.example.local) or an IPv4 address" >&2; exit 2
  fi
  san="${san:+$san,}$kind:$n"
done
printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && { echo "[tls] the first name must be the DNS name users open, not an IP" >&2; exit 2; }

mkdir -p "$DIR"
DIR="$(native "$DIR")"
umask 077
cat > "$DIR/csr.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
req_extensions = ext
[dn]
CN = $1
[ext]
subjectAltName = $san
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:"$BITS" -out "$DIR/server.key"
chmod 600 "$DIR/server.key"
openssl req -new -sha256 -key "$DIR/server.key" -config "$DIR/csr.cnf" -out "$DIR/server.csr"
openssl req -in "$DIR/server.csr" -noout -verify >/dev/null 2>&1 || { echo "[tls] the CSR does not verify" >&2; exit 1; }

echo "[tls] key and request made in $DIR"
echo "  subject     : CN=$1"
echo "  names (SAN) : $san"
echo "  key         : RSA $BITS, public key sha256 $(openssl pkey -in "$DIR/server.key" -pubout -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
echo "  send ONLY   : $DIR/server.csr  (template «Web Server»; ask for the issued certificate and the CA chain)"
echo "  keep here   : $DIR/server.key  (never copy or send it)"
echo "  then        : sh ops/tls/install-cert.sh <issued certificate> <CA chain>"
