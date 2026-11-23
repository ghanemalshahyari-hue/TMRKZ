#!/usr/bin/env sh
# TMRKZ on this machine with MOVER's identity and HR sources (owner, 17 Nov 2026; ADR-079): the same directory MOVER signs in
# against (mover-ldap, Samba AD, StartTLS, self-bind user@mover.local, CA «MOVER Dev LDAP CA») and the same Oracle sandbox
# (mover-oracle-hr, FREEPDB1). On the isolated server nothing here is run: the administrator enters MOVER's values in .env and
# in «إعدادات النظام ← مصدر الموارد البشرية» (docs/MOVER_SETTINGS_PARITY_AR.md). Idempotent; secrets are generated once into
# git-ignored files and travel on stdin only, never printed.
#   sh ops/local/use-mover-sources.sh          attach, CA, .env keys, accounts (then the steps it prints)
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
G=ops/local/.generated; mkdir -p "$G"
NET=tmrkz_internal
MOVER="${MOVER_DIR:-../../mover}"   # MOVER's folder (read only): its directory CA
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

# 1. MOVER's Oracle and directory join TMRKZ's isolated network (an extra network for those two containers; MOVER keeps its own)
docker network inspect "$NET" >/dev/null 2>&1 || { echo "[mover-sources] start TMRKZ first: sh start.sh" >&2; exit 2; }
for c in mover-oracle-hr mover-ldap; do
  docker inspect "$c" >/dev/null 2>&1 || { echo "[mover-sources] $c is not on this machine" >&2; exit 2; }
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" | grep -qw "$NET" || docker network connect "$NET" "$c"
done
echo "[mover-sources] mover-oracle-hr and mover-ldap reachable on $NET"

# 2. MOVER's directory CA in TMRKZ's truststore (Keycloak and the backend's manual sign-in)
cp "$MOVER/mover-state/config/ldap-dev-ca.pem" ops/keycloak/truststores/mover-dev-ldap-ca.pem
echo "[mover-sources] CA: $(openssl x509 -in ops/keycloak/truststores/mover-dev-ldap-ca.pem -noout -subject)"

# 3. TMRKZ's read-only Oracle account: SELECT on the two HR views only (MOVER's own MOVER_HR test password is not on this machine)
F="$G/mover-oracle-hr.env"
UNIT_VIEW="${MOVER_HR_UNIT_VIEW:-HR_AI.HR_ENV_UNITS_AI}"; PERSON_VIEW="${MOVER_HR_PERSON_VIEW:-HR_AI.HR_PRS_EMPLOYEES_ALL}"
[ -f "$F" ] || { umask 077; printf '# TMRKZ read-only account in MOVER'"'"'s local Oracle sandbox — test only, never production\nHOST=mover-oracle-hr\nPORT=1521\nSERVICE=FREEPDB1\nUSER=TMRKZ_HR\nPASSWORD=T%s\nUNIT_VIEW=%s\nPERSON_VIEW=%s\n' "$(rand 22)" "$UNIT_VIEW" "$PERSON_VIEW" > "$F"; }
PW="$(sed -n 's/^PASSWORD=//p' "$F")"
printf "whenever sqlerror exit 1\nalter session set container=FREEPDB1;\ndeclare n number; begin select count(*) into n from dba_users where username='TMRKZ_HR'; if n = 0 then execute immediate 'create user TMRKZ_HR identified by \"%s\" default tablespace users quota 0 on users'; end if; end;\n/\ngrant create session to TMRKZ_HR;\ngrant select on %s to TMRKZ_HR;\ngrant select on %s to TMRKZ_HR;\nexit\n" "$PW" "$UNIT_VIEW" "$PERSON_VIEW" \
  | docker exec -i mover-oracle-hr bash -c 'sqlplus -s / as sysdba' >/dev/null
echo "[mover-sources] Oracle: TMRKZ_HR reads $UNIT_VIEW and $PERSON_VIEW"

# 4. a read-only directory service account for Keycloak's federation (MOVER itself binds as each user and needs none)
S="$G/mover-ldap-svc.env"
[ -f "$S" ] || { umask 077; printf 'LDAP_BIND_DN=CN=svc_tmrkz_ro,CN=Users,DC=mover,DC=local\nLDAP_BIND_CREDENTIAL=Sv9-%s\n' "$(rand 22)" > "$S"; }
if ! docker exec mover-ldap samba-tool user show svc_tmrkz_ro >/dev/null 2>&1; then
  SPW="$(sed -n 's/^LDAP_BIND_CREDENTIAL=//p' "$S")"
  printf '%s\n%s\n' "$SPW" "$SPW" | docker exec -i mover-ldap samba-tool user create svc_tmrkz_ro --use-username-as-cn >/dev/null 2>&1
fi
echo "[mover-sources] directory service account svc_tmrkz_ro"

# 5. .env: MOVER's directory, in TMRKZ's keys (MOVER: LDAP_SERVER=mover-ldap LDAP_PORT=389 LDAP_DOMAIN=mover.local
#    LDAP_BASE_DN=DC=mover,DC=local LDAP_SECURITY_MODE=starttls; attributes MilNumber/MilRankName/MilOccupation/MilCurrentUnitName)
setkv() { if grep -q "^$1=" .env; then awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > .env.tmp && mv .env.tmp .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
setkv LDAP_URL "ldap://mover-ldap:389"
setkv LDAP_START_TLS true
setkv LDAP_BIND_DN "$(sed -n 's/^LDAP_BIND_DN=//p' "$S")"
setkv LDAP_BIND_CREDENTIAL "$(sed -n 's/^LDAP_BIND_CREDENTIAL=//p' "$S")"
setkv LDAP_USERS_DN "DC=mover,DC=local"
setkv LDAP_VENDOR ad
setkv LDAP_USERNAME_ATTRIBUTE sAMAccountName
setkv LDAP_UUID_ATTRIBUTE objectGUID
setkv LDAP_USER_OBJECT_CLASSES "person, organizationalPerson, user"
setkv LDAP_USER_OBJECT_CLASS user
setkv LDAP_EMPLOYEE_NUMBER_ATTRIBUTE "${MOVER_LDAP_NUMBER_ATTRIBUTE:-employeeNumber}"
setkv LDAP_DIRECT_BIND_PATTERN "{username}@mover.local"
setkv LDAP_ATTR_UNIT_ID "${MOVER_LDAP_UNIT_ID_ATTRIBUTE:-departmentNumber}"
setkv LDAP_ATTR_UNIT_NAME MilCurrentUnitName
setkv LDAP_ATTR_RANK MilRankName
setkv LDAP_ATTR_POSITION MilOccupation
setkv TMRKZ_OIDC_CLAIM_UNIT_ID tmrkz_unit_id
setkv TMRKZ_OIDC_CLAIM_UNIT_NAME tmrkz_unit_name
setkv TMRKZ_OIDC_CLAIM_RANK tmrkz_rank
setkv TMRKZ_OIDC_CLAIM_POSITION tmrkz_position
echo "[mover-sources] .env names MOVER's directory"
cat <<'EOF'
[mover-sources] next, in this order:
  sh start.sh                                                         (the stand-in directory is left out)
  CONFIRM=yes sh ops/keycloak/set-directory.sh tmrkz             (Keycloak's federation → mover-ldap, tested first)
  CONFIRM=yes sh ops/keycloak/set-employment-attributes.sh tmrkz
  sh ops/platform-accounts.sh tmrkz && sh ops/keycloak/set-platform-password-client.sh tmrkz
  node ops/local/mover-settings.mjs all                                (roles, Oracle source, MOVER's mapping, first sync)
EOF
