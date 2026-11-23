#!/usr/bin/env sh
# A TEMPORARY empty TMRKZ beside the one application (owner brief, 20 Nov 2026; ADR-094): compose project «tmrkz-empty» on
# :8098 with an empty database, its identity provider federated with the synthetic directory «tmrkz-synthetic-ad» and its HR
# source to be pointed at the demo Oracle «tmrkz-hr-demo-oracle» (both of profile synthetic-enterprise). For the acceptance
# journeys of tests/acceptance/hr-on-demand-journey.mjs only — never production; `down` removes it with its volumes.
#   sh ops/hr-demo/empty-install.sh up      build/start, connect the synthetic sources, create the platform accounts
#   sh ops/hr-demo/empty-install.sh down    remove the project and its volumes (the synthetic sources stay)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
P=tmrkz-empty
G=ops/hr-demo/.generated
[ -f "$G/synthetic-ad.env" ] && [ -f "$G/synthetic-ad/tls/ca.crt" ] || { echo "[empty] start the synthetic directory first: sh ops/hr-demo/synthetic-ad/up.sh" >&2; exit 2; }
docker inspect -f '{{.State.Running}}' tmrkz-hr-demo-oracle 2>/dev/null | grep -q true || { echo "[empty] start the demo Oracle first: sh ops/hr-demo/up.sh --large" >&2; exit 2; }
mkdir -p "$G/synthetic-ad/truststore" && cp "$G/synthetic-ad/tls/ca.crt" "$G/synthetic-ad/truststore/synthetic-ad-ca.pem"
export TMRKZ_HTTP_PORT=8098 TMRKZ_PUBLIC_URL=http://localhost:8098 TMRKZ_IP=127.0.0.1 TMRKZ_PORT=8098
export LDAP_URL=ldaps://tmrkz-synthetic-ad:636 LDAP_START_TLS=false
export LDAP_BIND_DN='CN=Administrator,CN=Users,DC=tmrkz,DC=test'
LDAP_BIND_CREDENTIAL="$(sed -n 's/^SYNTHETIC_AD_ADMIN_PASSWORD=//p' "$G/synthetic-ad.env")"; export LDAP_BIND_CREDENTIAL
export LDAP_USERS_DN='OU=People,DC=tmrkz,DC=test' LDAP_VENDOR=ad LDAP_USERNAME_ATTRIBUTE=sAMAccountName LDAP_UUID_ATTRIBUTE=objectGUID
export LDAP_USER_OBJECT_CLASSES='person, organizationalPerson, user' LDAP_USER_OBJECT_CLASS=user LDAP_EMPLOYEE_NUMBER_ATTRIBUTE=MilNumber
export LDAP_DIRECT_BIND_PATTERN='{username}@tmrkz.test'
export LDAP_ATTR_UNIT_ID=MilUnitId LDAP_ATTR_UNIT_NAME=MilCurrentUnitName LDAP_ATTR_MAIN_UNIT_ID=MilMainUnitId LDAP_ATTR_RANK=MilRankName LDAP_ATTR_POSITION=MilOccupation
export TMRKZ_OIDC_CLAIM_UNIT_ID=tmrkz_unit_id TMRKZ_OIDC_CLAIM_UNIT_NAME=tmrkz_unit_name TMRKZ_OIDC_CLAIM_MAIN_UNIT_ID=tmrkz_main_unit_id TMRKZ_OIDC_CLAIM_RANK=tmrkz_rank TMRKZ_OIDC_CLAIM_POSITION=tmrkz_position
export TMRKZ_TRUSTSTORE_DIR="./$G/synthetic-ad/truststore"
compose() { docker compose -p "$P" -f docker-compose.yml "$@"; }
case "${1:-}" in
  up)
    compose down -v >/dev/null 2>&1 || true
    compose up -d --build
    for c in tmrkz-synthetic-ad tmrkz-hr-demo-oracle; do docker network connect "${P}_internal" "$c" 2>/dev/null || true; done
    i=0
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "${P}-keycloak-1" 2>/dev/null)" = healthy ]; do
      i=$((i + 1)); [ $i -gt 80 ] && { echo "[empty] keycloak not healthy"; exit 1; }; sleep 3
    done
    sh ops/platform-accounts.sh "$P"
    sh ops/keycloak/set-platform-password-client.sh "$P"
    CONFIRM=yes sh ops/keycloak/set-employment-attributes.sh "$P" || true
    compose restart backend >/dev/null
    i=0
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "$TMRKZ_PUBLIC_URL/api/v1/auth/status")" = 200 ]; do
      i=$((i + 1)); [ $i -gt 100 ] && { echo "[empty] TMRKZ not ready"; exit 1; }; sleep 3
    done
    echo "[empty] up at $TMRKZ_PUBLIC_URL (project $P). Remove: sh ops/hr-demo/empty-install.sh down"
    ;;
  down)
    for c in tmrkz-synthetic-ad tmrkz-hr-demo-oracle; do docker network disconnect "${P}_internal" "$c" 2>/dev/null || true; done
    compose down -v
    echo "[empty] removed"
    ;;
  *) echo "usage: sh ops/hr-demo/empty-install.sh up|down" >&2; exit 2;;
esac
