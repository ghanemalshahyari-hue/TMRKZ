#!/usr/bin/env sh
# Acceptance environment ONLY: a fictional signing PKI for the certificate signature and seal (ADR-020), generated once
# under ops/test-env/.generated/signing/ (git-ignored). Never used in production, where certificates and keys come from
# the organisation's provider or HSM.
#   keystores/person-T-0008.p12  t.approver   (valid)
#   keystores/person-T-0009.p12  t.approver2  (REVOKED: signing is refused, which the test environment demonstrates)
#   keystores/seal-HR-T-GA.p12   seal of «الإدارة العامة» (organisation code HR-T-GA in the test HR mirror)
#   trust/ca.pem, crl/ca.crl, keystore-password
# Subjects are Latin on purpose: Git Bash hands arguments to openssl.exe through the ANSI code page.
# Sourced by ops/test-env/prepare.sh.
S=ops/test-env/.generated/signing
if [ ! -f "$S/crl/ca.crl" ]; then
  rm -rf "$S"
  mkdir -p "$S/ca/new" "$S/keystores" "$S/trust" "$S/crl" "$S/work"
  : > "$S/ca/index.txt"
  echo 1000 > "$S/ca/serial"
  echo 1000 > "$S/ca/crlnumber"
  head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > "$S/keystore-password"
  cat > "$S/ca/ca.cnf" <<EOF
[ ca ]
default_ca = test
[ test ]
dir = $S/ca
database = \$dir/index.txt
new_certs_dir = \$dir/new
certificate = \$dir/ca.crt
private_key = \$dir/ca.key
serial = \$dir/serial
crlnumber = \$dir/crlnumber
default_md = sha256
default_days = 825
default_crl_days = 30
policy = any
unique_subject = no
copy_extensions = none
[ any ]
commonName = supplied
organizationName = optional
[ sign ]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation
EOF
  openssl req -utf8 -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=TMRKZ Test Signing CA/O=TMRKZ Test" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$S/ca/ca.key" -out "$S/ca/ca.crt" 2>/dev/null
  cp "$S/ca/ca.crt" "$S/trust/ca.pem"
  issue() { # file, common name
    openssl req -utf8 -newkey rsa:2048 -nodes -subj "/CN=$2/O=TMRKZ Test" -keyout "$S/work/$1.key" -out "$S/work/$1.csr" 2>/dev/null
    openssl ca -utf8 -batch -config "$S/ca/ca.cnf" -extensions sign -in "$S/work/$1.csr" -out "$S/work/$1.crt" 2>/dev/null
    openssl pkcs12 -export -inkey "$S/work/$1.key" -in "$S/work/$1.crt" -certfile "$S/ca/ca.crt" -name signing \
      -passout "file:$S/keystore-password" -out "$S/keystores/$1.p12"
  }
  issue person-T-0008 "Test Approver T-0008"
  issue person-T-0009 "Test Approver T-0009 (revoked)"
  issue seal-HR-T-GA "Test Seal - General Administration"
  openssl ca -config "$S/ca/ca.cnf" -revoke "$S/work/person-T-0009.crt" -crl_reason keyCompromise 2>/dev/null
  openssl ca -config "$S/ca/ca.cnf" -gencrl -out "$S/work/ca.crl.pem" 2>/dev/null
  openssl crl -in "$S/work/ca.crl.pem" -outform DER -out "$S/crl/ca.crl"
  rm -rf "$S/work"/*.key
fi
