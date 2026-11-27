#!/usr/bin/env bash
# ADR-109 against the real identity provider: TMRKZ's sign-out ends the Keycloak session from the server (form POST to the
# end-session endpoint over the back channel, the session's ID token as hint, no post-logout address), so the browser never
# visits Keycloak on sign-out, and the next automatic sign-in asks for the password again.
#   bash tests/acceptance/signout/keycloak-signout.sh <evidence folder>
# A throwaway container of TMRKZ's own Keycloak image with the baked tmrkz realm, configured like docker-compose.yml (public
# hostname, dynamic back channel, /auth). A fictional user only; the container and the work files are removed at the end.
set -u
EV=$1; HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${KC_IMAGE:-tmrkz/keycloak:26.7.5-2}
KC=tmrkz-kc-signoutcheck-$$; PORT=18180
PUBLIC=http://public.invalid:9999          # what the browser sees (KC_HOSTNAME); the back channel is 127.0.0.1:$PORT
BACK=http://127.0.0.1:$PORT/auth/realms/tmrkz/protocol/openid-connect
# curl and python are Windows programs under Git Bash with MSYS_NO_PATHCONV=1 (needed for the docker exec paths): give them C:/ paths
command -v cygpath >/dev/null 2>&1 && HERE=$(cygpath -m "$HERE")
WORK="$HERE/work-$$"; mkdir -p "$WORK" "$EV"
ADMIN_PW=$(python -c "import secrets;print(secrets.token_urlsafe(18))")
USER_PW=$(python -c "import secrets;print(secrets.token_urlsafe(18))")
cleanup() { docker rm -fv "$KC" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 2' INT TERM
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS  $1 ($3)"; else fail=$((fail + 1)); echo "FAIL  $1 (expected $2, got $3)"; fi; }
CURL=(curl -s --connect-to "public.invalid:9999:127.0.0.1:$PORT")

docker run -d --name "$KC" -p "127.0.0.1:$PORT:8080" -e KC_DB=dev-file -e KC_HOSTNAME="$PUBLIC/auth" \
    -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true -e KC_HTTP_ENABLED=true -e KC_HEALTH_ENABLED=true -e KC_HTTP_RELATIVE_PATH=/auth \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=check -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PW" -e TMRKZ_PUBLIC_URL="$PUBLIC" \
    -e TMRKZ_OIDC_CLIENT_SECRET="$(python -c "import secrets;print(secrets.token_urlsafe(24))")" \
    -e TMRKZ_PLATFORM_OIDC_CLIENT_SECRET="$(python -c "import secrets;print(secrets.token_urlsafe(24))")" \
    -e LDAP_URL=ldap://directory.invalid:389 -e LDAP_START_TLS=false -e LDAP_USERS_DN=ou=people,dc=example,dc=test \
    -e LDAP_BIND_DN=cn=nobody,dc=example,dc=test -e LDAP_BIND_CREDENTIAL=unused \
    "$IMAGE" start-dev --import-realm >/dev/null || exit 1
up=no
for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BACK/certs")" = 200 ] && { up=yes; break; }
    [ "$(docker inspect -f '{{.State.Running}}' "$KC" 2>/dev/null)" = true ] || break
    sleep 2
done
if [ "$up" != yes ]; then echo "Keycloak did not start:"; docker logs "$KC" 2>&1 | tail -5; exit 1; fi
echo "Keycloak: $(docker exec "$KC" /opt/keycloak/bin/kc.sh --version 2>/dev/null | grep -m1 -i keycloak)"

kcadm() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@"; }
kcadm config credentials --server http://localhost:8080/auth --realm master --user check --password "$ADMIN_PW" >/dev/null 2>&1 || exit 1
# the realm's directory federation points nowhere here: removed, so the fictional user is a plain Keycloak user
for c in $(kcadm get components -r tmrkz -q providerId=ldap --fields id 2>/dev/null | python -c "import json,sys;print(' '.join(x['id'] for x in json.load(sys.stdin)))"); do
    kcadm delete "components/$c" -r tmrkz >/dev/null 2>&1
done
kcadm create users -r tmrkz -s username=signout.check -s enabled=true -s email=signout.check@example.test -s emailVerified=true \
    -s firstName=Signout -s lastName=Check >/dev/null
kcadm set-password -r tmrkz --username signout.check --new-password "$USER_PW"
UID_=$(kcadm get users -r tmrkz -q username=signout.check --fields id 2>/dev/null | python -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
secret() { kcadm get "clients/$(kcadm get clients -r tmrkz -q clientId="$1" --fields id 2>/dev/null | python -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")/client-secret" -r tmrkz 2>/dev/null \
    | python -c "import json,sys;print(json.load(sys.stdin)['value'])"; }
WEB_SECRET=$(secret tmrkz-web)
# the platform-password client as ops/keycloak/set-platform-password-client.sh registers it (no refresh tokens, basic+profile)
PWD_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(24))")
if [ "$(kcadm get clients -r tmrkz -q clientId=tmrkz-platform-password --fields id 2>/dev/null | python -c "import json,sys;print(len(json.load(sys.stdin)))")" = 0 ]; then
    printf '%s' "{\"clientId\":\"tmrkz-platform-password\",\"enabled\":true,\"protocol\":\"openid-connect\",\"publicClient\":false,
      \"clientAuthenticatorType\":\"client-secret\",\"secret\":\"$PWD_SECRET\",\"standardFlowEnabled\":false,\"implicitFlowEnabled\":false,
      \"directAccessGrantsEnabled\":true,\"serviceAccountsEnabled\":false,\"frontchannelLogout\":false,\"fullScopeAllowed\":false,
      \"redirectUris\":[],\"webOrigins\":[],\"attributes\":{\"use.refresh.tokens\":\"false\",\"post.logout.redirect.uris\":\"$PUBLIC/?signed-out=1\"},
      \"defaultClientScopes\":[\"basic\",\"profile\"],\"optionalClientScopes\":[]}" \
        | docker exec -i "$KC" /opt/keycloak/bin/kcadm.sh create clients -r tmrkz -f - >/dev/null
else
    PWD_SECRET=$(secret tmrkz-platform-password)
fi
sessions() { kcadm get "users/$UID_/sessions" -r tmrkz 2>/dev/null | python -c "import json,sys;print(len(json.load(sys.stdin)))"; }

# ---- 1. automatic sign-in (authorization code + PKCE) through a browser cookie jar ------------------------------------
VERIFIER=$(python -c "import secrets;print(secrets.token_urlsafe(48))")
CHALLENGE=$(python -c "import hashlib,base64,sys;print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).decode().rstrip('='))" "$VERIFIER")
AUTH="$PUBLIC/auth/realms/tmrkz/protocol/openid-connect/auth?client_id=tmrkz-web&response_type=code&scope=openid%20profile&redirect_uri=$PUBLIC/api/v1/auth/oidc/callback&state=s1&nonce=n1&code_challenge=$CHALLENGE&code_challenge_method=S256"
JAR="$WORK/browser.jar"
"${CURL[@]}" -c "$JAR" -b "$JAR" -o "$WORK/login.html" "$AUTH"
ACTION=$(python -c "import re,html,sys;m=re.search(r'<form[^>]*action=\"([^\"]+)\"',sys.stdin.read());print(html.unescape(m.group(1)) if m else '')" < "$WORK/login.html")
check "Keycloak shows its sign-in form at first" "yes" "$([ -n "$ACTION" ] && echo yes || echo no)"
LOC=$("${CURL[@]}" -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' --data-urlencode username=signout.check --data-urlencode "password=$USER_PW" "$ACTION")
CODE=$(python -c "import urllib.parse,sys;print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query).get('code',[''])[0])" "$LOC")
ID_TOKEN=$(curl -s -u "tmrkz-web:$WEB_SECRET" --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" \
    --data-urlencode "redirect_uri=$PUBLIC/api/v1/auth/oidc/callback" --data-urlencode "code_verifier=$VERIFIER" "$BACK/token" \
    | python -c "import json,sys;print(json.load(sys.stdin).get('id_token',''))")
check "the code is exchanged over the back channel for an ID token" "yes" "$([ -n "$ID_TOKEN" ] && echo yes || echo no)"
check "the user has one Keycloak session" "1" "$(sessions)"
SSO=$("${CURL[@]}" -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' "$AUTH")
check "before sign-out, a new automatic sign-in passes without the password (SSO)" "302" "$SSO"
check "... still one session" "1" "$(sessions)"

# ---- 2. TMRKZ's sign-out: the server's form POST, the browser is not involved ----------------------------------------
STATUS=$(curl -s -o "$WORK/logout.html" -w '%{http_code}' --data-urlencode client_id=tmrkz-web --data-urlencode "id_token_hint=$ID_TOKEN" "$BACK/logout")
check "the back-channel end-session POST is accepted (no redirect, no confirmation)" "200" "$STATUS"
check "the Keycloak session is gone" "0" "$(sessions)"
"${CURL[@]}" -c "$JAR" -b "$JAR" -o "$WORK/again.html" -w '%{http_code}' "$AUTH" > "$WORK/again.code"
check "after sign-out, the same browser's automatic sign-in asks for the password again" "200" "$(cat "$WORK/again.code")"
check "... and it is Keycloak's sign-in form" "yes" "$(grep -q 'name="password"' "$WORK/again.html" && echo yes || echo no)"

# ---- 3. a platform account's manual sign-in (password client, no browser cookie) -------------------------------------
PTOKEN=$(curl -s -u "tmrkz-platform-password:$PWD_SECRET" --data-urlencode grant_type=password --data-urlencode username=signout.check \
    --data-urlencode "password=$USER_PW" --data-urlencode "scope=openid profile" "$BACK/token" \
    | python -c "import json,sys;print(json.load(sys.stdin).get('id_token',''))")
check "the manual platform sign-in opens a Keycloak session" "1" "$(sessions)"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' --data-urlencode client_id=tmrkz-platform-password --data-urlencode "id_token_hint=$PTOKEN" "$BACK/logout")
check "its sign-out is accepted over the back channel" "200" "$STATUS"
check "that Keycloak session is gone too" "0" "$(sessions)"

# ---- 4. what the browser used to see (before ADR-109): the same request from the browser shows Keycloak's page --------
"${CURL[@]}" -o "$WORK/old.html" -w '%{http_code}' "$PUBLIC/auth/realms/tmrkz/protocol/openid-connect/logout?client_id=tmrkz-web" > "$WORK/old.code"
check "(before) a browser sent to Keycloak's logout without a valid hint gets Keycloak's own page" "200" "$(cat "$WORK/old.code")"

echo; echo "== result: $pass passed, $fail failed"
[ "$fail" = 0 ]
