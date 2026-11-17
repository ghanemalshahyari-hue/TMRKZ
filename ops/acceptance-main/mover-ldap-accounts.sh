#!/usr/bin/env sh
# ACCEPTANCE ONLY. The test accounts of tests/acceptance/acc79-mover-settings.mjs in MOVER's local dev directory (mover-ldap,
# Samba AD), for SYNTHETIC people of MOVER's Oracle sandbox (HR_AI: TNQL's 100 % synthetic data), with the Unit ID in
# departmentNumber. Owner approval, 17 Nov 2026 (ADR-079); removed after the run. The service account svc_tmrkz_ro belongs to
# ops/local/use-mover-sources.sh and stays. The password is generated once into a git-ignored file and travels on stdin only.
#   sh ops/acceptance-main/mover-ldap-accounts.sh add|remove
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
A=ops/acceptance-main/.generated; mkdir -p "$A"
MAN="$A/mover-ldap-test-accounts.txt"
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
[ -f "$A/mover-ldap-test-password" ] || { umask 077; printf 'Tz9-%s' "$(rand 18)" > "$A/mover-ldap-test-password"; }
TPW="$(cat "$A/mover-ldap-test-password")"

# login (= the person's PERSON_USER_ID in HR_AI) | Unit ID stated by the directory | employee number | role in the run
ACCOUNTS='darwish.atyby85|100007|N10587950|new1
saqer.ghfly92|100007|3139951|uam
ibrahim.nqby74|100007|3495538|mover
obaid.kaby98|100007|3184752|req1
rashed.zaaby83|100007|3558443|req2
saif.hmady72|100008|N10587999|new2
hazza.kndy101|100008|N10587933|srcB
matar.zahry80|100007|N10587988|mismatch
zayed.rmythy71|100005|N10587105|final
mansoor.tnyjy80|100005|N10580821|fin
jasem.zahry89|100006|N10587506|opsb
tariq.hmady90|999999|N10587875|unknown'

if [ "${1:-add}" = remove ]; then
  echo "$ACCOUNTS" | while IFS='|' read -r u _ _ _; do docker exec mover-ldap samba-tool user delete "$u" >/dev/null 2>&1 && echo "removed $u" || true; done
  exit 0
fi

: > "$MAN"
echo "$ACCOUNTS" | while IFS='|' read -r u unit emp role; do
  if ! docker exec mover-ldap samba-tool user show "$u" >/dev/null 2>&1; then
    printf '%s\n%s\n' "$TPW" "$TPW" | docker exec -i mover-ldap samba-tool user create "$u" --use-username-as-cn >/dev/null 2>&1
  fi
  # the synthetic person's name as the sandbox holds it
  name="$(printf "set pagesize 0 feedback off\nalter session set container=FREEPDB1;\nselect full_name from HR_AI.HR_PRS_EMPLOYEES_ALL where person_user_id = '%s';\nexit\n" "$u" \
    | docker exec -i mover-oracle-hr bash -c 'NLS_LANG=AMERICAN_AMERICA.AL32UTF8 sqlplus -s / as sysdba' | tr -d '\r' | grep -v '^$' | head -1)"
  printf 'dn: CN=%s,CN=Users,DC=mover,DC=local\nchangetype: modify\nreplace: employeeNumber\nemployeeNumber: %s\n-\nreplace: departmentNumber\ndepartmentNumber: %s\n-\nreplace: displayName\ndisplayName: %s\n-\nreplace: description\ndescription: TMRKZ acceptance test account (synthetic HR_AI person) — %s\n' \
    "$u" "$emp" "$unit" "${name:-$u}" "$role" | docker exec -i mover-ldap ldbmodify -H /var/lib/samba/private/sam.ldb >/dev/null
  echo "$u|$role" >> "$MAN"
done
echo "accounts: $(wc -l < "$MAN") test accounts in mover-ldap"
