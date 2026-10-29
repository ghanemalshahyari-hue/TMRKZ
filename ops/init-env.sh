#!/usr/bin/env sh
# Generates .env with random secrets (run once per environment). Existing .env is never overwritten.
set -eu
cd "$(dirname "$0")/.."
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
if [ -f .env ]; then
  # Existing values are never changed; keys introduced by later versions are added once.
  grep -q '^TMRKZ_HR_SETTINGS_KEY=' .env || { echo "TMRKZ_HR_SETTINGS_KEY=$(rand 48)" >> .env; echo "added TMRKZ_HR_SETTINGS_KEY"; }
  echo ".env already exists — existing values unchanged"; exit 0
fi
DEMO="${1:-}"
{
  echo "MOVER_DB_PASSWORD=$(rand 32)"
  echo "MOVER_ATTESTATION_KEY=$(rand 48)"
  echo "TMRKZ_HR_SETTINGS_KEY=$(rand 48)"
  echo "MOVER_HTTP_PORT=8088"
  echo "MOVER_SECURE_COOKIE=false"
  if [ "$DEMO" = "--demo" ]; then
    echo "MOVER_DEMO_MODE=true"
    echo "MOVER_DEMO_SEED=true"
    echo "MOVER_DEMO_PASSWORD=Demo-$(rand 10)"
  else
    echo "MOVER_DEMO_MODE=false"
    echo "MOVER_DEMO_SEED=false"
    echo "MOVER_DEMO_PASSWORD="
  fi
} > .env
chmod 600 .env
echo ".env created"
[ "$DEMO" = "--demo" ] && grep MOVER_DEMO_PASSWORD .env || true
