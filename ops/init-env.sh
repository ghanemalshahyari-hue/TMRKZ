#!/usr/bin/env sh
# Generates .env with random secrets (run once per environment). Existing .env is never overwritten.
set -eu
cd "$(dirname "$0")/.."
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
if [ -f .env ]; then
  # Existing values are never changed; keys introduced by later versions are added once.
  for k in TMRKZ_HR_SETTINGS_KEY:48 TMRKZ_OIDC_CLIENT_SECRET:48 TMRKZ_KEYCLOAK_DB_PASSWORD:32 TMRKZ_KEYCLOAK_ADMIN_PASSWORD:32 \
           TMRKZ_OPENFGA_DB_PASSWORD:32 TMRKZ_OPENFGA_API_TOKEN:48; do
    name=${k%%:*}; len=${k##*:}
    grep -q "^$name=" .env || { echo "$name=$(rand "$len")" >> .env; echo "added $name"; }
  done
  grep -q '^TMRKZ_PUBLIC_URL=' .env || { echo "TMRKZ_PUBLIC_URL=http://localhost:8088" >> .env; echo "added TMRKZ_PUBLIC_URL"; }
  echo ".env already exists — existing values unchanged"; exit 0
fi
{
  echo "MOVER_DB_PASSWORD=$(rand 32)"
  echo "MOVER_ATTESTATION_KEY=$(rand 48)"
  echo "TMRKZ_HR_SETTINGS_KEY=$(rand 48)"
  echo "TMRKZ_OIDC_CLIENT_SECRET=$(rand 48)"
  echo "TMRKZ_KEYCLOAK_DB_PASSWORD=$(rand 32)"
  echo "TMRKZ_KEYCLOAK_ADMIN_PASSWORD=$(rand 32)"
  echo "TMRKZ_OPENFGA_DB_PASSWORD=$(rand 32)"
  echo "TMRKZ_OPENFGA_API_TOKEN=$(rand 48)"
  echo "TMRKZ_PUBLIC_URL=http://localhost:8088"
  echo "MOVER_HTTP_PORT=8088"
  echo "MOVER_SECURE_COOKIE=false"
  echo "# Enterprise directory used by Keycloak (fill in from the organisation; see docs/OPERATIONS.md)"
  echo "LDAP_URL="
  echo "LDAP_START_TLS=true"
  echo "LDAP_BIND_DN="
  echo "LDAP_BIND_CREDENTIAL="
  echo "LDAP_USERS_DN="
} > .env
chmod 600 .env
echo ".env created"
