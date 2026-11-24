#!/usr/bin/env sh
# Generates .env with random secrets (run once per environment). Existing .env is never overwritten.
set -eu
cd "$(dirname "$0")/.."
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
if [ -f .env ]; then
  # Settings once named MOVER_* (the project's first working name) are called TMRKZ_* since 23 Nov 2026 (ADR-098): the
  # line is renamed, its value kept. Written in place (cat >), since a shared folder may refuse a rename of .env.
  for pair in MOVER_DB_PASSWORD:TMRKZ_DB_PASSWORD MOVER_ATTESTATION_KEY:TMRKZ_ATTESTATION_KEY MOVER_HTTP_PORT:TMRKZ_HTTP_PORT \
              MOVER_HTTP_BIND:TMRKZ_HTTP_BIND MOVER_SECURE_COOKIE:TMRKZ_SECURE_COOKIE; do
    old=${pair%%:*}; new=${pair##*:}
    if grep -q "^$old=" .env && ! grep -q "^$new=" .env; then
      sed "s/^$old=/$new=/" .env > .env.next && cat .env.next > .env && rm -f .env.next; echo "renamed $old to $new"
    fi
  done
  # Existing values are never changed; keys introduced by later versions are added once.
  for k in TMRKZ_DB_PASSWORD:32 TMRKZ_ATTESTATION_KEY:48 TMRKZ_HR_SETTINGS_KEY:48 TMRKZ_OIDC_CLIENT_SECRET:48 \
           TMRKZ_KEYCLOAK_DB_PASSWORD:32 TMRKZ_KEYCLOAK_ADMIN_PASSWORD:32 \
           TMRKZ_OPENFGA_DB_PASSWORD:32 TMRKZ_OPENFGA_API_TOKEN:48 TMRKZ_PLATFORM_OIDC_CLIENT_SECRET:48 \
           TMRKZ_PLATFORM_ADMIN_PASSWORD:20 TMRKZ_PLATFORM_DEVELOPER_PASSWORD:20; do
    name=${k%%:*}; len=${k##*:}
    grep -q "^$name=" .env || { echo "$name=$(rand "$len")" >> .env; echo "added $name"; }
  done
  grep -q '^TMRKZ_PUBLIC_URL=' .env || { echo "TMRKZ_PUBLIC_URL=http://localhost:8088" >> .env; echo "added TMRKZ_PUBLIC_URL"; }
  echo ".env already exists — existing values unchanged"; exit 0
fi
{
  echo "TMRKZ_DB_PASSWORD=$(rand 32)"
  echo "TMRKZ_ATTESTATION_KEY=$(rand 48)"
  echo "TMRKZ_HR_SETTINGS_KEY=$(rand 48)"
  echo "TMRKZ_OIDC_CLIENT_SECRET=$(rand 48)"
  echo "TMRKZ_PLATFORM_OIDC_CLIENT_SECRET=$(rand 48)"
  echo "TMRKZ_KEYCLOAK_DB_PASSWORD=$(rand 32)"
  echo "TMRKZ_KEYCLOAK_ADMIN_PASSWORD=$(rand 32)"
  echo "TMRKZ_OPENFGA_DB_PASSWORD=$(rand 32)"
  echo "TMRKZ_OPENFGA_API_TOKEN=$(rand 48)"
  echo "# Lasting platform accounts admin / developer (ops/platform-accounts.sh); change them here, then re-run that script"
  echo "TMRKZ_PLATFORM_ADMIN_PASSWORD=$(rand 20)"
  echo "TMRKZ_PLATFORM_DEVELOPER_PASSWORD=$(rand 20)"
  echo "TMRKZ_PUBLIC_URL=http://localhost:8088"
  echo "TMRKZ_HTTP_PORT=8088"
  echo "TMRKZ_SECURE_COOKIE=false"
  echo "# Enterprise directory (fill in from the organisation, or on the screen «إعدادات التكامل»; see docs/OPERATIONS.md)"
  echo "LDAP_URL="
  echo "LDAP_START_TLS=true"
  echo "# optional read-only service account (ADR-100: not needed — each person binds as {username}@LDAP_DOMAIN)"
  echo "LDAP_BIND_DN="
  echo "LDAP_BIND_CREDENTIAL="
  echo "LDAP_USERS_DN="
  echo "# people sign in as {username}@LDAP_DOMAIN; empty = the DC= parts of LDAP_USERS_DN"
  echo "LDAP_DOMAIN="
} > .env
chmod 600 .env
echo ".env created"
